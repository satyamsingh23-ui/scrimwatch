// src/utils/api.js
import axios from 'axios'

const API_BASE_URL = import.meta.env.VITE_API_URL ||
                     (import.meta.env.DEV ? '' : '')

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
export const getLogs        = (lines = 150) => api.get(`/logs?lines=${lines}`)

// Stats endpoints
export const getLeaderboard   = (guildId, days = 7)   => api.get(`/stats/${guildId}/leaderboard?days=${days}`)
export const getRecentStats   = (guildId, days = 7)   => api.get(`/stats/${guildId}/recent?limit=100`)
export const getStatsSummary  = (guildId)              => api.get(`/stats/${guildId}/summary`)
export const getPlayerHistory = (guildId, player, days = 30) => api.get(`/stats/${guildId}/leaderboard?days=${days}`)

export default api