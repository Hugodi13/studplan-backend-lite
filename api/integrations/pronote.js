const pronote = require('pronote-api-maintained')

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

  try {
    const normalizedUrl = normalizePronoteUrl(url)
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
