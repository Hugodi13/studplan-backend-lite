const pronote = require('pronote-api-maintained')
const pronoteCooldowns = new Map()
const PRONOTE_COOLDOWN_MS = 15 * 60 * 1000

const setCors = (res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
}

const normalizePronoteUrl = (value) => {
  const raw = String(value || '').trim()
  if (!raw) return ''
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
  const withoutEleveHtml = withProtocol.replace(/\/eleve\.html?$/i, '/')
  return withoutEleveHtml.endsWith('/') ? withoutEleveHtml : `${withoutEleveHtml}/`
}

const safePronoteUrlForLogs = (value) => {
  try {
    const u = new URL(value)
    return `${u.origin}${u.pathname}`
  } catch {
    return String(value || '')
  }
}

const normalizeCas = (value) => {
  const raw = String(value || '').trim().toLowerCase()
  if (!raw) return undefined
  if (raw === 'ac-aix-marseille') return 'atrium-sud'
  if (raw === 'aix-marseille') return 'atrium-sud'
  return raw
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

const getClientIp = (req) => {
  const forwarded = req.headers?.['x-forwarded-for']
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim()
  }
  return req.ip || req.socket?.remoteAddress || 'unknown'
}

const getCooldownKey = (req, normalizedUrl, username) =>
  [getClientIp(req), normalizedUrl, String(username || '').trim().toLowerCase()].join('|')

const getRemainingCooldownMs = (key) => {
  const until = pronoteCooldowns.get(key)
  if (!until) return 0
  const remaining = until - Date.now()
  if (remaining <= 0) {
    pronoteCooldowns.delete(key)
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

const toTask = (hw) => {
  const title = hw.subject?.name
    ? `Devoir ${hw.subject.name}`
    : hw.description
      ? String(hw.description).slice(0, 80)
      : 'Devoir Pronote'

  return {
    title: String(title).trim() || 'Devoir Pronote',
    subject: hw.subject?.name || 'Pronote',
    description: hw.description || '',
    difficulty: 'moyen',
    estimated_minutes: 30,
    due_date: toIsoDate(hw.for) || toIsoDate(hw.givenAt),
  }
}

module.exports = async (req, res) => {
  setCors(res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { url, username, password, cas } = req.body || {}
  if (!url || !username || !password) {
    return res.status(400).json({ error: 'Missing pronote credentials' })
  }

  const normalizedUrl = normalizePronoteUrl(url)
  const cooldownKey = getCooldownKey(req, normalizedUrl, username)
  const remainingMs = getRemainingCooldownMs(cooldownKey)
  if (remainingMs > 0) {
    const waitMin = Math.max(1, Math.ceil(remainingMs / 60000))
    res.setHeader('Retry-After', String(Math.ceil(remainingMs / 1000)))
    return res.status(429).json({
      error: 'Pronote a temporairement bloqué les tentatives depuis ce backend.',
      details: `Réessaie dans environ ${waitMin} min pour éviter un nouveau blocage.`,
    })
  }

  try {
    const normalizedCas = normalizeCas(cas)
    const casCandidates = normalizedCas
      ? [normalizedCas]
      : [undefined, 'atrium-sud', 'none']

    let lastError = null
    let tasks = []
    for (const casTry of casCandidates) {
      try {
        const session = await withTimeout(
          pronote.login(
            normalizedUrl,
            String(username).trim(),
            String(password),
            casTry,
          ),
          30000,
          'Pronote login',
        )
        const homeworks = await withTimeout(session.homeworks(), 30000, 'Pronote homeworks')
        tasks = Array.isArray(homeworks) ? homeworks.map(toTask).filter((t) => t.title) : []
        lastError = null
        break
      } catch (attemptError) {
        lastError = attemptError
      }
    }

    if (lastError) throw lastError

    return res.status(200).json({
      mock: false,
      source: 'pronote',
      tasks,
    })
  } catch (error) {
    const msg = String(error?.message || '')
    const safeUrl = safePronoteUrlForLogs(normalizedUrl)
    console.warn('Pronote sync failed', {
      code: error?.code || null,
      name: error?.name || null,
      message: msg || null,
      url: safeUrl,
      hasCas: Boolean(cas),
    })
    if (/temporarily banned|too many failed authentication attempts/i.test(msg)) {
      pronoteCooldowns.set(cooldownKey, Date.now() + PRONOTE_COOLDOWN_MS)
      res.setHeader('Retry-After', String(Math.ceil(PRONOTE_COOLDOWN_MS / 1000)))
      return res.status(429).json({
        error: 'Pronote bloque temporairement cette connexion (trop de tentatives).',
        details: 'Patiente 15 minutes puis réessaie avec les bons identifiants.',
      })
    }
    const wrongCredentialsCode = pronote?.errors?.WRONG_CREDENTIALS?.code
    if (error?.code === wrongCredentialsCode || /credential|identifiant|mot de passe|login/i.test(msg)) {
      return res.status(401).json({ error: 'Identifiants Pronote invalides.' })
    }
    if (error?.code === 'ETIMEDOUT' || /ETIMEDOUT|timeout|timed out/i.test(msg)) {
      return res.status(504).json({
        error: 'Serveur Pronote non joignable depuis le backend.',
        details:
          'Le serveur de ton établissement ne répond pas à temps. Réessaie plus tard ou héberge le backend sur un autre fournisseur/région.',
      })
    }
    return res.status(500).json({
      error: 'Connexion Pronote impossible.',
      details: msg || 'Erreur backend Pronote',
    })
  }
}
