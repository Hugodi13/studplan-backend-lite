const express = require('express')
const pronoteHandler = require('./api/integrations/pronote')
const ecoledirecteHandler = require('./api/integrations/ecoledirecte')

const app = express()
const port = process.env.PORT || 3000

app.use(express.json({ limit: '1mb' }))
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (req.method === 'OPTIONS') return res.status(204).end()
  return next()
})

app.get('/', (_req, res) => {
  res.status(200).json({ ok: true, service: 'studplan-backend-lite' })
})

app.all('/api/integrations/pronote', (req, res) => pronoteHandler(req, res))
app.all('/api/integrations/ecoledirecte', (req, res) => ecoledirecteHandler(req, res))

app.use((err, _req, res, _next) => {
  console.error('Express unhandled error:', err)
  if (res.headersSent) return
  res.status(500).json({ error: 'Erreur serveur backend.' })
})

process.on('unhandledRejection', (reason) => {
  const msg = String(reason?.message || '')
  if (reason?.code === 'ECONNRESET' || /ECONNRESET|socket hang up/i.test(msg)) {
    console.warn('Network reset from remote school API (handled)')
    return
  }
  console.error('Unhandled rejection:', reason)
})

process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error)
})

app.listen(port, () => {
  console.log(`studplan-backend-lite listening on :${port}`)
})
