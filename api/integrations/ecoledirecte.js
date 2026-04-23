const EcoleDirecte = require('node-ecole-directe')

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

  try {
    const session = new EcoleDirecte.Session()
    const connected = await withTimeout(
      session.connexion(String(username).trim(), String(password)),
      30000,
      'EcoleDirecte login',
    )

    // node-ecole-directe can return either a single account-like object
    // or a list depending on account type/version.
    const account = Array.isArray(connected)
      ? connected[0]
      : connected

    const target =
      account && typeof account.fetchCahierDeTexte === 'function'
        ? account
        : Array.isArray(account?.eleves) && account.eleves.length
          ? account.eleves[0]
          : null

    if (!target || typeof target.fetchCahierDeTexte !== 'function') {
      return res.status(500).json({
        error: 'Connexion École Directe impossible.',
        details: 'Format de compte non reconnu par le connecteur.',
      })
    }

    const homework = await withTimeout(target.fetchCahierDeTexte(), 30000, 'EcoleDirecte homeworks')

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
    if (error?.code === 'ETIMEDOUT' || /ETIMEDOUT|timeout|timed out|délai/i.test(msg)) {
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
