// src/utils/api.js
import axios from 'axios'

const API_BASE_URL = import.meta.env.VITE_API_URL || ''

const api = axios.create({
  baseURL: API_BASE_URL,
  timeout: 15000,
  headers: { 'Content-Type': 'application/json' },
})

export const getStatus      = () => api.get('/status')
export const getIdpHistory  = (hours = 24) => api.get(`/idphistory?hours=${hours}`)
export const getSlots       = (guildId) => api.get(`/slots/${guildId}`)
export const clearSlots     = (guildId) => api.post(`/slots/${guildId}/clear`)
export const getChannels    = (guildId) => api.get(`/channels/${guildId}`)
export const getRoster      = (guildId) => api.get('/roster', { params: { guild_id: guildId } })
export const getMatchExplorer = (guildId, params = {}) => api.get('/matches/explore', {
  params: { guild_id: guildId, ...params },
})
export const getLogs        = (lines = 150) => api.get(`/logs?lines=${lines}`)

// Stats endpoints
export const getLeaderboard   = (guildId, days = 7, rosterOnly = true) => api.get(`/stats/${guildId}/leaderboard`, { params: { days, roster_only: rosterOnly } })
export const getRecentStats   = (guildId, limit = 20, rosterOnly = true) => api.get(`/stats/${guildId}/recent`, { params: { limit, roster_only: rosterOnly } })
export const getStatsSummary  = (guildId, rosterOnly = true) => api.get(`/stats/${guildId}/summary`, { params: { roster_only: rosterOnly } })
export const getPlayerHistory = (guildId, player, days=30) => api.get(`/stats/${guildId}/leaderboard?days=${days}`)

export default api