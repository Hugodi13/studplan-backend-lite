const EcoleDirecte = require('node-ecole-directe')

const setCors = (res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
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
    const account = await session.connexion(String(username).trim(), String(password))
    const homework = await account.fetchCahierDeTexte()

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
