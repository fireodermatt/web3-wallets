/* eslint-disable */

import React, { useState, createContext } from 'react'
import Web3 from 'web3'

import isMobile from 'ismobilejs'

import WalletConnect from '@walletconnect/client'
import QRCodeModal from '@walletconnect/qrcode-modal'

import { ToastContainer, toast, Slide } from 'react-toastify'
import 'react-toastify/dist/ReactToastify.css'

import { MetaMaskInpageProvider } from '@metamask/providers'

import { Connection, PublicKey, Transaction, clusterApiUrl } from '@solana/web3.js'

import { getNetworkById } from './networks'
import { checkEnsValid, parseAddressFromEnsSolana, parseEnsFromSolanaAddress } from './utils/solana'

declare global {
  interface Window {
    ethereum: MetaMaskInpageProvider
    solana: any
  }
}

interface WalletInterface {
  isLoading: boolean
  isConnected: boolean
  name: null | 'WalletConnect' | 'MetaMask' | 'Phantom'
  chainId: null | number
  address: string | null
  addressShort: string | null
  addressDomain: null | string
  web3: Web3 | null // todo: types
  provider: any // 📌 TODO: add interface
  restore: Function
  connect: Function
  changeNetwork: Function
  sendTx: Function
  disconnect: Function
}

export const WalletContext = createContext<WalletInterface>({
  isLoading: false,
  isConnected: false,
  name: null,
  chainId: null,
  address: '',
  addressShort: '',
  addressDomain: null,
  web3: null,
  provider: null,
  restore: () => {},
  connect: () => {},
  changeNetwork: () => {},
  sendTx: () => {},
  disconnect: () => {}
})

const names = {
  WalletConnect: 'WalletConnect',
  MetaMask: 'MetaMask',
  Phantom: 'Phantom'
}

let isMetamaskHandler = false

let connector // wc

const goMetamask = () => {
  //if (isMobile(window.navigator).apple.device) {
  if (isMobile(window.navigator).any) {
    /*
      open app in mobile metamask
      info: https://docs.metamask.io/guide/mobile-best-practices.html#deeplinking

      `https://checkout.webill.io/nft/bb811382-1f1b-4376-8884-5f74bd808f83/`
      ->
      `https://metamask.app.link/dapp/checkout.webill.io/nft/bb811382-1f1b-4376-8884-5f74bd808f83/`
    */
    const locationHref = window.location.href
    let locationHrefNoProtocol = locationHref.replace('http://', '')
    locationHrefNoProtocol = locationHrefNoProtocol.replace('https://', '')
    const deepLink = `https://metamask.app.link/dapp/${locationHrefNoProtocol}`
    window.location.href = deepLink
  }
  if (!isMobile(window.navigator).any) {
    window.open('https://chrome.google.com/webstore/detail/metamask/nkbihfbeogaeaoehlefnkodbefgpgknn')
  }
}

const goPhantom = () => {
  const url = 'https://chrome.google.com/webstore/detail/phantom/bfnaelmomeimhlpmgjnjophhpkkoljpa'
  if (window) {
    window.open(url, '_blank')
  }
}

interface StateProps {
  isLoading: boolean
  isConnected: boolean
  name: null | 'WalletConnect' | 'MetaMask' | 'Phantom'
  provider: any
  web3: Web3 | null
  chainId: null | number
  address: string | null
  addressShort: string | null
  addressDomain: string | null
}

const Wallet = props => {
  const [state, setState] = useState<StateProps>({
    isLoading: false,
    isConnected: false,
    name: null,
    provider: null,
    web3: null,
    chainId: null,
    address: null,
    addressShort: null,
    addressDomain: null
  })

  const getDomain = async address => {
    if (!address) {
      return null
    }
    try {
      // ENS test
      //const address = '0xd8da6bf26964af9d7eed9e03e53415d37aa96045'
      const answer = await (await fetch(`https://domains.1inch.io/reverse-lookup?address=${address}`)).json()
      const domain = answer.domain
      return domain
    } catch (e) {
      console.warn(`Can't get domain, ${e}`)
    }
    return null
  }

  const restore = async () => {
    console.log('Wallet.restore()')

    await dropWC()

    const savedName = localStorage.getItem('web3-wallets-name')
    if (savedName === names.MetaMask) {
      const isUnlocked = window.ethereum?._metamask?.isUnlocked && (await window.ethereum._metamask.isUnlocked())
      if (isUnlocked) {
        return await connectMetamask()
      } else {
        return false
      }
    }
    if (savedName === names.WalletConnect) {
      // todo: restore WC session
    }
    if (savedName === names.Phantom) {
      return await connectPhantom(-1, true)
    }
  }

  const connectMetamask = async (chainId?: string | number) => {
    if (!window.ethereum || !window.ethereum.isMetaMask) {
      return false
    }

    const provider_ = window.ethereum
    const chainIdHex_ = provider_.chainId
    let chainId_ = typeof chainIdHex_ === 'string' ? parseInt(chainIdHex_) : null

    let accounts

    try {
      accounts = await provider_.request({
        method: 'eth_requestAccounts'
      })
    } catch (e) {
      // @ts-ignore
      if (e.code === 4001) {
        console.warn('User rejected the request', e)
        return false
      } else {
        throw e
      }
    }

    console.log('accounts = ', accounts)
    const address_ = accounts[0]
    const addressDomain_ = await getDomain(address_)

    if (chainId) {
      // go change network
      const network = getNetworkById(chainId)
      if (!network.data.params) {
        throw new Error('Missing network params')
      }
      const isNeedToChangeNetwork = chainId_ !== network.chain_id
      if (isNeedToChangeNetwork) {
        await metamaskChangeNetwork(network.data.params)
        chainId_ = network.chain_id
      }
    }

    if (!isMetamaskHandler) {
      provider_.on('chainChanged', metamaskChainChangeHandler)
      provider_.on('accountsChanged', metamaskAccountChangeHandler)
      isMetamaskHandler = true
    }

    setState(prev => ({
      ...prev,
      ...{
        isConnected: true,
        name: 'MetaMask',
        provider: provider_,
        //@ts-ignore
        web3: new Web3(provider_),
        chainId: chainId_,
        address: address_,
        addressShort: shortenAddress(address_),
        addressDomain: addressDomain_
      }
    }))

    localStorage.setItem('web3-wallets-name', names.MetaMask)
    return true
  }

  const connectWC = ({ showQR = false, chainId = '' }) => {
    /*
      showQR === false | only reconnect
      showQR === true  | try to connect + show QR
    */

    console.log('connectWC()', showQR ? '(connect+QR)' : '(reconnect)')

    return new Promise(resolve => {
      connector = new WalletConnect({
        bridge: 'https://bridge.walletconnect.org',
        qrcodeModal: QRCodeModal
      })

      console.log('connector: ', connector)

      if ((connector.connected && showQR) || (!connector.connected && !showQR)) {
        resolve(false)
      }

      if (!connector.connected && showQR) {
        console.log('no session, create')
        connector.createSession()
      }

      if (connector.connected && !showQR) {
        console.log('restore session: ', connector.session)
        console.log('WC reconnect not implemented, drop session')
        try {
          connector.killSession()
        } catch (e) {
          console.warn(e)
        }
        resolve(false)
      }

      /*
        Events:
          - connect
          - disconnect
          - session_request
          - session_update
          - call_request
          - wc_sessionRequest
          - wc_sessionUpdate
        */

      connector.on('connect', async (error, payload) => {
        // only after QR scan
        console.log('* connected', payload)
        //toast.success('[dapp ⮀ wallet] Connected')

        if (error) {
          throw error
        }

        // Get provided accounts and chainId
        const { accounts, chainId: walletChainId } = payload.params[0]

        const dappChainId = chainId
        console.info('dappChainId', dappChainId)
        console.info('walletChainId', walletChainId)

        if (walletChainId !== dappChainId) {
          /*
            Note: WalletConnect v1 is not able to switch networks
          */
          toast.warn('Wrong wallet network — disconnected')
          console.warn('[Wallet] Wrong wallet network — disconnected')
          connector.killSession()
          resolve(false)
          return
        }

        const address_ = accounts[0]
        const addressDomain_ = await getDomain(address_)

        const network = getNetworkById(chainId)
        const rpcUrl = network.rpc_url
        console.log('rpcUrl', rpcUrl)
        const provider_ = new Web3.providers.HttpProvider(rpcUrl)
        const web3_ = new Web3(provider_)

        setState(prev => ({
          ...prev,
          ...{
            isConnected: true,
            name: 'WalletConnect',
            provider: provider_,
            web3: web3_,
            chainId: walletChainId,
            address: address_,
            addressShort: shortenAddress(address_),
            addressDomain: addressDomain_
          }
        }))

        localStorage.setItem('web3-wallets-name', names.WalletConnect)
        resolve(true)
      })

      connector.on('session_request', (error, payload) => {
        console.log('* session_request', error, payload)
      })

      connector.on('session_update', (error, payload) => {
        console.log('* session_update', payload)

        if (error) {
          throw error
        }

        console.log('chainId', state.chainId)

        // Get updated accounts and chainId
        const { /*accounts,*/ chainId: newChainId } = payload.params[0]
        //console.log(accounts, newChainId)

        //const account = accounts[0] // todo: account

        if (newChainId !== state.chainId) {
          //toast.info(`[wallet] chainId changed to ${newChainId}`)
          setState(prev => ({
            ...prev,
            ...{
              chainId: newChainId
            }
          }))
        }
      })

      connector.on('call_request', (error, payload) => {
        console.log('* call_request', error, payload)
      })

      connector.on('disconnect', (error, payload) => {
        console.log('* disconnect', payload)

        /*
          "Session Rejected" = reject after QR scan
          "Session Disconnected" = disconnected by dapp
          "Session disconnected" = disconnected by wallet
        */

        if (payload.params[0]?.message === 'Session Rejected') {
          //toast.warn('[wallet] Connection rejected')
          console.log('[Wallet] Session rejected')
          resolve(false)
        }

        if (payload.params[0]?.message === 'Session disconnected') {
          //toast.info('[wallet] Disconnected')
          console.log('[Wallet] Disconnected (by wallet)')
        }

        if (payload.params[0]?.message === 'Session Disconnected') {
          //toast.info('[dapp] Disconnected')
          console.log('[Wallet] Disconnected (by dapp)')
        }

        if (error) {
          throw error
        }

        setState(prev => ({
          ...prev,
          ...{
            isConnected: false,
            name: null,
            provider: null,
            web3: null,
            chainId: null,
            address: null,
            addressShort: null,
            addressDomain: null
          }
        }))
        localStorage.removeItem('web3-wallets-name')
      })
    })
  }

  const connectPhantom = async (chainId = -1, isRecconect = false) => {
    if (chainId !== -1 && chainId !== -1001) {
      throw new Error(`Unknown Phantom chainId ${chainId}`)
    }
    try {
      const resp = isRecconect ? await window.solana.connect({ onlyIfTrusted: true }) : await window.solana.connect()
      const address_ = resp.publicKey.toString()
      const domain = await parseEnsFromSolanaAddress(address_)

      setState(prev => ({
        ...prev,
        ...{
          isConnected: true,
          name: 'Phantom',
          provider: window.solana,
          web3: null,
          chainId: chainId,
          address: address_,
          addressShort: shortenAddress(address_),
          addressDomain: domain
        }
      }))

      localStorage.setItem('web3-wallets-name', names.Phantom)
      return true
    } catch (err) {
      // @ts-ignore
      if (err.code === 4001) {
        console.warn('[Wallet] User rejected the request.')
        return false
      }
      console.error('[Wallet]', err)
    }
  }

  const dropWC = () => {
    return connectWC({ showQR: false })
  }

  const metamaskChainChangeHandler = chainIdHex => {
    // todo: fix state
    /*if (!state.isConnected) {
      return
    }*/
    const chainId_ = parseInt(chainIdHex)
    console.log('* chainChanged', chainIdHex, chainId_)
    setState(prev => ({
      ...prev,
      ...{
        chainId: chainId_
      }
    }))
  }

  const metamaskAccountChangeHandler = async accounts => {
    console.log('* accountsChanged', accounts)

    // todo: fix state
    /*if (!state.isConnected) {
      return
    }*/

    if (!accounts.length) {
      // metamask disconnect
      disconnect()
    }

    const address_ = accounts[0]
    const addressDomain_ = await getDomain(address_)

    setState(prev => ({
      ...prev,
      ...{
        address: address_,
        addressShort: shortenAddress(address_),
        addressDomain: addressDomain_
      }
    }))
  }

  const connect = async ({ name, chainId }) => {
    console.log('Wallet.connect()', name, chainId)
    if (!names[name]) {
      console.error(`Unknown wallet name: ${name}`)
      return
    }

    if (name === 'MetaMask') {
      if (!window.ethereum || !window.ethereum.isMetaMask) {
        goMetamask()
        return false
      }
      return await connectMetamask(chainId)
    }

    if (name === 'WalletConnect') {
      return connectWC({ showQR: true, chainId })
    }

    if (name === 'Phantom') {
      const isPhantomInstalled = window.solana && window.solana.isPhantom
      if (!isPhantomInstalled) {
        goPhantom()
        return false
      }
      return await connectPhantom(chainId)
    }
  }

  const metamaskChangeNetwork = async params => {
    const newChainIdHex = params[0].chainId
    const { ethereum } = window

    try {
      await ethereum.request({
        method: 'wallet_switchEthereumChain',
        params: [
          {
            chainId: newChainIdHex
          }
        ]
      })
      return true
    } catch (error) {
      console.warn('Cant change network:', error)

      // @ts-ignore
      if (error.code === 4902) {
        // the chain has not been added to MetaMask
        try {
          console.log('Try to add the network...', params)
          await ethereum.request({
            method: 'wallet_addEthereumChain',
            params: params
          })
          // todo:
          // Users can allow adding, but not allowing switching
          return true
        } catch (error) {
          console.warn('Cant add the network:', error)
          return false
        }
      }
    }
    return false
  }

  const changeNetwork = async (name, chainId) => {
    console.log('Wallet.changeNetwork()', chainId)

    const network = getNetworkById(chainId)
    const params = network.data.params
    // console.log('state.name', state.name)
    /*if (state.name === 'MetaMask') {*/
    // todo: stale state
    if (name === 'MetaMask') {
      const isChanged = await metamaskChangeNetwork(params)
      if (isChanged) {
        setState(prev => ({
          ...prev,
          ...{
            chainId: chainId
          }
        }))
        return true
      }
      return false
    }

    if (state.name === 'WalletConnect') {
      // todo (show new QR)
    }
    if (name === 'Phantom') {
      // todo: make something better
      return true
    }
  }

  const sendTx = async (transaction, { signers = [] } = {}) => {
    console.log('[Wallet] sendTx', transaction)

    if (state.name === 'MetaMask') {
      return await state.provider.request({
        method: 'eth_sendTransaction',
        params: [transaction]
      })
    }

    if (state.name === 'WalletConnect') {
      return await connector.sendTransaction(transaction)
    }

    if (state.name === 'Phantom') {
      let cluster
      if (state.chainId === -1001) {
        cluster = 'testnet'
      }
      if (state.chainId === -1) {
        cluster = 'mainnet-beta'
      }
      if (!cluster) {
        throw new Error(`Unknown state.chainId ${state.chainId} -> cluster ${cluster}`)
      }
      const solanaNetwork = clusterApiUrl(cluster)
      const connection = new Connection(solanaNetwork)
      const provider = window.solana

      transaction.feePayer = provider.publicKey
      console.log('Getting recent blockhash')
      transaction.recentBlockhash = transaction.recentBlockhash || (await connection.getRecentBlockhash()).blockhash

      if (signers.length) {
        transaction.partialSign(...signers)
        console.log('partialSigned')
      }

      try {
        const signed = await provider.signTransaction(transaction)
        console.log('signed', signed)
        console.log('Got signature, submitting transaction...')
        const rawTx = signed.serialize()
        let signature = await connection.sendRawTransaction(rawTx)
        // todo: sendRawTransaction Commitment
        console.log(`Tx submitted`, signature)
        ;(async () => {
          console.log(`Waiting for network confirmation...`)
          await connection.confirmTransaction(signature)
          console.log('Tx confirmed!', signature)
          console.log(`See explorer:`)
          console.log(`https://solscan.io/tx/${signature}${cluster === 'testnet' ? '?cluster=testnet' : ''}`)
        })()
        return signature
      } catch (err) {
        console.warn(err)
        console.log('[Wallet error] sendTransaction: ' + JSON.stringify(err))
      }
    }
  }

  /*const request = async (params) => {
    // from provider
  }*/

  const disconnect = () => {
    console.log('Wallet.disconnect()')

    if (state.name === 'MetaMask') {
      if (state.provider) {
        state.provider.removeListener('chainChanged', metamaskChainChangeHandler)
        state.provider.removeListener('accountsChanged', metamaskAccountChangeHandler)
        isMetamaskHandler = false
      }
    }

    if (state.name === 'WalletConnect') {
      connector.killSession()
    }

    if (state.name === 'Phantom') {
      window.solana.disconnect()
    }

    setState(prev => ({
      ...prev,
      ...{
        isConnected: false,
        name: null,
        provider: null,
        web3: null,
        chainId: null,
        address: null,
        addressShort: null,
        addressDomain: null
      }
    }))
    localStorage.removeItem('web3-wallets-name')
  }

  return (
    <WalletContext.Provider
      value={{
        isLoading: false, // todo
        isConnected: state.isConnected,
        name: state.name,
        chainId: state.chainId,
        address: state.address,
        addressShort: state.addressShort,
        addressDomain: state.addressDomain,
        web3: state.web3,
        provider: state.provider,
        restore,
        connect,
        changeNetwork,
        sendTx,
        disconnect
      }}
    >
      {props.children}
      <ToastContainer position="top-right" newestOnTop={true} transition={Slide} />
    </WalletContext.Provider>
  )
}

export default Wallet

export const isValidAddress = async (chainId: number, address: string) => {
  if (chainId > 0) {
    if (address.slice(-4) === '.eth') {
      const rpc = getNetworkById(1).rpc_url
      const provider = new Web3.providers.HttpProvider(rpc)
      const result = await new Web3(provider).eth.ens.getAddress(address)
      return !!result
    }
    return Web3.utils.isAddress(address)
  }
  if (chainId === -1 || chainId === -1001) {
    try {
      if (address.slice(-4) === '.sol') {
        await checkEnsValid(address)
        return true
      }
      return Boolean(new PublicKey(address))
    } catch (e) {
      return false
    }
  }
  if (chainId === -3 || chainId === -1003) {
    // example:
    // EQBj0KYB_PG6zg_F3sjLwFkJ5C02aw0V10Dhd256c-Sr3BvF
    // EQCudP0_Xu7qi-aCUTCNsjXHvi8PNNL3lGfq2Wcmbg2oN-Jg
    // EQAXqKCSrUFgPKMlCKlfyT2WT7GhVzuHyXiPtDvT9s5FMp5o
    return (
      address.length === 48 &&
      (address.slice(0, 2) === 'EQ' ||
        address.slice(0, 2) === 'kQ' ||
        address.slice(0, 2) === 'Ef' ||
        address.slice(0, 2) === 'UQ') &&
      /^[a-zA-Z0-9_-]*$/.test(address)
    )
  }
  throw new Error(`Not implemented or wrong chainId ${chainId}`)
}

export const shortenAddress = address => {
  if (typeof address === 'string') {
    if (address.at(-4) === '.') {
      return address
    } else {
      return [address.slice(0, address.slice(0, 2) === '0x' ? 6 : 4), '...', address.slice(address.length - 4)].join('')
    }
  }

  return ''
}

export const nativeTokenAddress = (chainId: number) => {
  if (chainId === -1 || chainId === -1001) {
    return 'So11111111111111111111111111111111111111111'
  }
  if (chainId > 0) {
    return '0x0000000000000000000000000000000000000000'
  }
}

export const parseAddressFromEns = async (input: string) => {
  if (input.slice(-4) === '.sol') {
    return await parseAddressFromEnsSolana(input)
  } else if (input.slice(-4) === '.eth') {
    const rpc = getNetworkById(1).rpc_url
    const provider = new Web3.providers.HttpProvider(rpc)
    const result = await new Web3(provider).eth.ens.getAddress(input)
    return result
  } else {
    return input
  }
}
