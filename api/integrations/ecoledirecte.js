const EcoleDirecte = require('node-ecole-directe')
const edCooldowns = new Map()
const ED_NETWORK_COOLDOWN_MS = 8 * 60 * 1000

const setCors = (res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
}

const withTimeout = async (promise, timeoutMs, label) => {
  let timeoutId
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      const err = new Error(`${label} timed out`)
      err.code = 'ETIMEDOUT'
      reject(err)
    }, timeoutMs)
  })
  try {
    return await Promise.race([promise, timeoutPromise])
  } finally {
    clearTimeout(timeoutId)
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const isTransientNetworkError = (error) => {
  const msg = String(error?.message || '')
  return (
    error?.code === 'ETIMEDOUT' ||
    error?.code === 'ECONNRESET' ||
    error?.code === 'EAI_AGAIN' ||
    /ETIMEDOUT|ECONNRESET|EAI_AGAIN|timeout|timed out|socket hang up/i.test(msg)
  )
}

const pickHomeworkTarget = (connected) => {
  const account = Array.isArray(connected) ? connected[0] : connected
  if (!account) return null
  if (typeof account.fetchCahierDeTexte === 'function') return account
  if (Array.isArray(account?.eleves) && account.eleves.length) {
    const firstStudent = account.eleves.find((s) => typeof s?.fetchCahierDeTexte === 'function')
    if (firstStudent) return firstStudent
  }
  return null
}

const getClientIp = (req) => {
  const forwarded = req.headers?.['x-forwarded-for']
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim()
  }
  return req.ip || req.socket?.remoteAddress || 'unknown'
}

const getCooldownKey = (req, username) =>
  [getClientIp(req), String(username || '').trim().toLowerCase()].join('|')

const getRemainingCooldownMs = (key) => {
  const until = edCooldowns.get(key)
  if (!until) return 0
  const remaining = until - Date.now()
  if (remaining <= 0) {
    edCooldowns.delete(key)
    return 0
  }
  return remaining
}

const toIsoDate = (value) => {
  if (!value) return undefined
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return undefined
  return date.toISOString().slice(0, 10)
}

const toTask = (item) => ({
  title: item.matiere || item.aFaire || 'Devoir École Directe',
  subject: item.matiere || 'École Directe',
  description: item.aFaire || '',
  difficulty: 'moyen',
  estimated_minutes: 30,
  due_date: toIsoDate(item.date || item.donneLe),
})

module.exports = async (req, res) => {
  setCors(res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { username, password } = req.body || {}
  if (!username || !password) {
    return res.status(400).json({ error: 'Missing Ecole Directe credentials' })
  }
  const cooldownKey = getCooldownKey(req, username)
  const remainingMs = getRemainingCooldownMs(cooldownKey)
  if (remainingMs > 0) {
    const waitMin = Math.max(1, Math.ceil(remainingMs / 60000))
    res.setHeader('Retry-After', String(Math.ceil(remainingMs / 1000)))
    return res.status(429).json({
      error: 'École Directe est temporairement indisponible depuis ce backend.',
      details: `Réessaie dans environ ${waitMin} min pour éviter les boucles réseau.`,
    })
  }

  try {
    const maxAttempts = 4
    let homework = null
    let lastError = null

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const session = new EcoleDirecte.Session()
        const connected = await withTimeout(
          session.connexion(String(username).trim(), String(password)),
          30000,
          'EcoleDirecte login',
        )
        const target = pickHomeworkTarget(connected)
        if (!target || typeof target.fetchCahierDeTexte !== 'function') {
          return res.status(500).json({
            error: 'Connexion École Directe impossible.',
            details: 'Format de compte non reconnu par le connecteur.',
          })
        }
        homework = await withTimeout(target.fetchCahierDeTexte(), 30000, 'EcoleDirecte homeworks')
        lastError = null
        break
      } catch (err) {
        lastError = err
        if (attempt < maxAttempts && isTransientNetworkError(err)) {
          const delay = 900 * attempt + Math.floor(Math.random() * 400)
          await sleep(delay)
          continue
        }
        break
      }
    }

    if (lastError) throw lastError

    const flattened = Array.isArray(homework)
      ? homework
      : Object.values(homework || {}).flatMap((items) => (Array.isArray(items) ? items : []))

    const tasks = flattened.map(toTask).filter((t) => t.title)

    return res.status(200).json({
      mock: false,
      source: 'ecoledirecte',
      tasks,
    })
  } catch (error) {
    const msg = String(error?.message || '')
    if (/credential|identifiant|mot de passe|login|invalid/i.test(msg)) {
      return res.status(401).json({ error: 'Identifiants École Directe invalides.' })
    }
    if (error?.code === 'ECONNRESET' || /ECONNRESET|socket hang up|network reset/i.test(msg)) {
      edCooldowns.set(cooldownKey, Date.now() + ED_NETWORK_COOLDOWN_MS)
      res.setHeader('Retry-After', String(Math.ceil(ED_NETWORK_COOLDOWN_MS / 1000)))
      return res.status(503).json({
        error: 'Connexion École Directe réinitialisée par le serveur distant.',
        details: 'Le service École Directe coupe la connexion. Réessaie dans quelques minutes.',
      })
    }
    if (error?.code === 'ETIMEDOUT' || /ETIMEDOUT|timeout|timed out|délai/i.test(msg)) {
      edCooldowns.set(cooldownKey, Date.now() + ED_NETWORK_COOLDOWN_MS)
      res.setHeader('Retry-After', String(Math.ceil(ED_NETWORK_COOLDOWN_MS / 1000)))
      return res.status(504).json({
        error: 'Serveur École Directe non joignable depuis le backend.',
        details:
          'Le serveur distant ne répond pas à temps. Réessaie plus tard ou change de fournisseur/région backend.',
      })
    }
    return res.status(500).json({
      error: 'Connexion École Directe impossible.',
      details: msg || 'Erreur backend École Directe',
    })
  }
}
