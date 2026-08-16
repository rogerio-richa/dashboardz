import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles.css'

// @ts-expect-error plain JS module without types
import { loadInstalledPacks } from '../../static/device/widgets/packs.mjs'
// @ts-expect-error plain JS module without types
import { register } from '../../static/device/widgets/registry.mjs'

// Installed theme-pack designs join the catalogue first, so every design list, label and preview
// includes them. The loader never rejects and gives up after a few seconds.
loadInstalledPacks({ register }).finally(() => {
  ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>)
})
