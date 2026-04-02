import {
  type Amount,
  SetHookFlags,
  type Wallet,
  calculateHookOn,
  convertStringToHex,
  dropsToXah,
  xahToDrops,
} from 'xahau'

import {
  serverUrl,
  type XrplIntegrationTestContext,
  setupClient,
  teardownClient,
} from '@transia/hooks-toolkit/dist/npm/src/libs/xrpl-helpers'
import { compileC } from '@xahau/hooks-cli'

import {
  type SetHookParams,
  setHooksV3,
  hexNamespace,
  type iHook,
  readHookBinaryHexFromNS,
  clearAllHooksV3,
  clearHookStateV3,
  Xrpld,
} from '@transia/hooks-toolkit'

import {
  currencyToHex,
  xflToHex,
  xrpAddressToHex,
} from '@transia/binary-models'
import type { Account } from 'xahau/dist/npm/models/transactions/common'

const namespace = 'namespace'

describe('tipbot', () => {
  let testContext: XrplIntegrationTestContext

  beforeAll(async () => {
    await compileC('./top.c', 'build/')
    await compileC('./tip.c', 'build/')
    testContext = await setupClient(serverUrl)
    const hook1 = {
      CreateCode: readHookBinaryHexFromNS('../build/top', 'wasm'),
      Flags: SetHookFlags.hsfOverride,
      HookOn: calculateHookOn(['Remit']),
      HookNamespace: hexNamespace(namespace),
      HookApiVersion: 0,
    } as iHook
    const hook2 = {
      CreateCode: readHookBinaryHexFromNS('../build/tip', 'wasm'),
      Flags: SetHookFlags.hsfOverride,
      HookOn: calculateHookOn(['Invoke']),
      HookNamespace: hexNamespace(namespace),
      HookApiVersion: 0,
    } as iHook
    await setHooksV3({
      client: testContext.client,
      wallet: testContext.hook1,
      hooks: [{ Hook: hook1 }, { Hook: hook2 }],
    } as SetHookParams)
  })

  afterAll(async () => {
    const clearHook = {
      Flags: SetHookFlags.hsfNSDelete,
      HookNamespace: hexNamespace(namespace),
    } as iHook
    await clearHookStateV3({
      client: testContext.client,
      wallet: testContext.hook1,
      hooks: [{ Hook: clearHook }, { Hook: clearHook }],
    } as SetHookParams)
    await clearAllHooksV3({
      client: testContext.client,
      wallet: testContext.hook1,
    } as SetHookParams)
    await teardownClient(testContext)
  })

  const deposit = async (account: Wallet, userId: number, amount: Amount) => {
    return await Xrpld.submit(testContext.client, {
      tx: {
        TransactionType: 'Remit',
        Account: account.address,
        Destination: testContext.hook1.address,
        Amounts: [{ AmountEntry: { Amount: amount } }],
        HookParameters: [
          {
            HookParameter: {
              HookParameterName: convertStringToHex('DEPOSIT'),
              HookParameterValue: `01${'00'.repeat(11)}${userId.toString(16).padStart(16, '0')}`,
            },
          },
        ],
      },
      wallet: account,
    })
  }

  const withdraw = async (account: Wallet, amount: Amount) => {
    let paramValue = ''
    if (typeof amount === 'string') {
      paramValue = `${'00'.repeat(20)}${'00'.repeat(20)}${xflToHex(dropsToXah(amount), true)}`
    } else {
      const currency = currencyToHex(amount.currency)
      const issuer = xrpAddressToHex(amount.issuer)
      paramValue += currency
      paramValue += issuer
      paramValue += xflToHex(Number.parseFloat(amount.value), true)
    }
    return await Xrpld.submit(testContext.client, {
      tx: {
        TransactionType: 'Remit',
        Account: account.address,
        Destination: testContext.hook1.address,
        HookParameters: [
          {
            HookParameter: {
              HookParameterName: convertStringToHex('WITHDRAW'),
              HookParameterValue: paramValue,
            },
          },
        ],
      },
      wallet: account,
    })
  }

  type Opinion = {
    socialNetworkId: number
    postId: number
    userIdTo: number | Account
    userIdFrom: number
    amount: Amount
  }

  const makeOpinionHexValue = (
    socialNetworkId: Opinion['socialNetworkId'],
    postId: Opinion['postId'],
    userIdTo: Opinion['userIdTo'],
    userIdFrom: Opinion['userIdFrom'],
    amount: Opinion['amount'],
  ) => {
    let hex = ''
    if (socialNetworkId < 0 || socialNetworkId > 255)
      throw new Error('Social Network ID must be between 0 and 255')
    hex += socialNetworkId.toString(16).padStart(2, '0')
    if (postId < 0 || postId > 2 ** 64 - 1)
      throw new Error('Post ID must be between 0 and 2**64-1')
    hex += postId.toString(16).padStart(16, '0')
    if (typeof userIdTo === 'string') {
      hex += xrpAddressToHex(userIdTo).toUpperCase()
    } else {
      if (userIdTo < 0 || userIdTo > 2 ** 64 - 1)
        throw new Error('User ID to must be between 0 and 2**64-1')
      hex += userIdTo.toString(16).padStart(40, '0')
    }
    if (userIdFrom < 0 || userIdFrom > 2 ** 64 - 1)
      throw new Error('User ID from must be between 0 and 2**64-1')
    hex += userIdFrom.toString(16).padStart(16, '0')
    if (typeof amount === 'string') {
      hex += '00'.repeat(20)
      hex += '00'.repeat(20)
      hex += xflToHex(dropsToXah(amount), true)
    } else {
      const currency = currencyToHex(amount.currency)
      const issuer = xrpAddressToHex(amount.issuer)
      hex += currency
      hex += issuer
      hex += xflToHex(Number.parseFloat(amount.value), true)
    }
    return hex
  }

  const tip = async (account: Wallet, opinions: Opinion[]) => {
    return await Xrpld.submit(testContext.client, {
      tx: {
        TransactionType: 'Invoke',
        Account: account.address,
        Destination: testContext.hook1.address,
        HookParameters: opinions.map((opinion, index) => ({
          HookParameter: {
            HookParameterName: index.toString(16).padStart(2, '0'),
            HookParameterValue: makeOpinionHexValue(
              opinion.socialNetworkId,
              opinion.postId,
              opinion.userIdTo,
              opinion.userIdFrom,
              opinion.amount,
            ),
          },
        })),
      },
      wallet: account,
    })
  }

  it('Native Amount', async () => {
    // deposit
    {
      const response = await deposit(testContext.alice, 1, xahToDrops('100'))
      expect(response.meta).toHaveProperty('HookExecutions')
    }

    // tip to user 1
    {
      const opinions: Opinion[] = [
        {
          socialNetworkId: 1,
          postId: 0,
          userIdTo: 0,
          userIdFrom: 1,
          amount: xahToDrops('1'),
        },
      ]
      for (const acc of [testContext.hook2, testContext.hook3]) {
        const response = await tip(acc, opinions)
        expect(response.meta).toHaveProperty('HookExecutions')
      }
    }
    // tip to bob
    {
      const opinions: Opinion[] = [
        {
          socialNetworkId: 1,
          postId: 2,
          userIdTo: testContext.bob.address,
          userIdFrom: 1,
          amount: xahToDrops('1'),
        },
      ]
      for (const acc of [testContext.hook2, testContext.hook3]) {
        const response = await tip(acc, opinions)
        expect(response.meta).toHaveProperty('HookExecutions')
      }
    }

    // withdraw
    {
      const response = await withdraw(testContext.bob, xahToDrops('0.01'))
      expect(response.meta).toHaveProperty('HookExecutions')
    }
  })

  it('IOU Amount', async () => {
    const ic = testContext.ic
    // deposit
    {
      const response = await deposit(
        testContext.alice,
        1,
        ic.set(100).amount as unknown as Amount,
      )
      expect(response.meta).toHaveProperty('HookExecutions')
    }

    // tip to user 1
    {
      const opinions: Opinion[] = [
        {
          socialNetworkId: 1,
          postId: 123,
          userIdTo: 0,
          userIdFrom: 1,
          amount: ic.set(50).amount as unknown as Amount,
        },
      ]
      for (const acc of [testContext.hook2, testContext.hook3]) {
        const response = await tip(acc, opinions)
        expect(response.meta).toHaveProperty('HookExecutions')
      }
    }
    // tip to bob
    {
      const opinions: Opinion[] = [
        {
          socialNetworkId: 1,
          postId: 456,
          userIdTo: testContext.bob.address,
          userIdFrom: 1,
          amount: ic.set(40).amount as unknown as Amount,
        },
      ]
      for (const acc of [testContext.hook2, testContext.hook3]) {
        const response = await tip(acc, opinions)
        expect(response.meta).toHaveProperty('HookExecutions')
      }
    }

    // withdraw
    {
      const response = await withdraw(
        testContext.bob,
        ic.set(10).amount as unknown as Amount,
      )
      expect(response.meta).toHaveProperty('HookExecutions')
    }
  })
})
