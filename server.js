const express = require('express')
const pronoteHandler = require('./api/integrations/pronote')
const ecoledirecteHandler = require('./api/integrations/ecoledirecte')

const app = express()
const port = process.env.PORT || 3000

app.use(express.json({ limit: '1mb' }))

app.get('/', (_req, res) => {
  res.status(200).json({ ok: true, service: 'studplan-backend-lite' })
})

app.all('/api/integrations/pronote', (req, res) => pronoteHandler(req, res))
app.all('/api/integrations/ecoledirecte', (req, res) => ecoledirecteHandler(req, res))

app.listen(port, () => {
  console.log(`studplan-backend-lite listening on :${port}`)
})
