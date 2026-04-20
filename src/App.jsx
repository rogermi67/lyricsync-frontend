import { useState, useEffect, useRef, useCallback } from 'react'
import './App.css'

const BACKEND = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001'
const INTERVAL_SEARCHING = 20000
const INTERVAL_SEARCHING_FAST = 10000
const FALLBACK_TIMEOUT = 360000
const MIN_RECOGNIZE_GAP = 30000  // minimo 30s tra una chiamata API e la successiva
const LYRICS_TICK = 250
const SILENCE_THRESHOLD = 0.01
const SILENCE_DURATION = 8000
const MIN_PLAY_TIME = 15000
const MAX_CONSECUTIVE_FAILS = 2
const FAIL_BACKOFF_BASE = 30000   // 30s dopo il primo fail
const FAIL_BACKOFF_MAX = 300000   // max 5 minuti tra tentativi
const MIN_FONT = 12
const MAX_FONT = 32
const DEFAULT_FONT = 20

// ─── Cache localStorage ────────────────────────────────────────────────────
const CACHE_KEY = 'lyricsync_cache'
const CACHE_MAX = 200 // massimo canzoni in cache

function getCache() {
  try {
    return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}')
  } catch { return {} }
}

function saveToCache(shazamKey, songData, syncedLyrics, plainLyrics) {
  try {
    const cache = getCache()
    const existing = cache[shazamKey] || {}
    cache[shazamKey] = {
      song: { ...existing.song, title: songData.title, artist: songData.artist, album: songData.album, year: songData.year, cover: songData.cover, artistImage: songData.artistImage, shazamKey: songData.shazamKey },
      syncedLyrics: syncedLyrics || existing.syncedLyrics || null,
      plainLyrics: plainLyrics || existing.plainLyrics || null,
      ts: Date.now()
    }
    // Limita dimensione cache: rimuovi le più vecchie
    const keys = Object.keys(cache)
    if (keys.length > CACHE_MAX) {
      keys.sort((a, b) => (cache[a].ts || 0) - (cache[b].ts || 0))
      for (let i = 0; i < keys.length - CACHE_MAX; i++) delete cache[keys[i]]
    }
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache))
    console.log(`💾 Cache: salvata "${songData.title}" (${keys.length} canzoni in cache)`)
  } catch (e) { console.warn('Cache write error:', e) }
}

function getFromCache(shazamKey) {
  try {
    const cache = getCache()
    return cache[shazamKey] || null
  } catch { return null }
}

// Estrae colore dominante da un'immagine (via canvas ridotto)
function extractDominantColor(imageUrl) {
  return new Promise((resolve) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      const canvas = document.createElement('canvas')
      const ctx = canvas.getContext('2d')
      // Riduce a 10x10 per media colori (evita outlier di 1x1)
      canvas.width = 10
      canvas.height = 10
      ctx.drawImage(img, 0, 0, 10, 10)
      const data = ctx.getImageData(0, 0, 10, 10).data
      let r = 0, g = 0, b = 0, count = 0
      for (let i = 0; i < data.length; i += 4) {
        // Ignora pixel troppo scuri o troppo chiari
        const brightness = (data[i] + data[i+1] + data[i+2]) / 3
        if (brightness > 30 && brightness < 220) {
          r += data[i]; g += data[i+1]; b += data[i+2]; count++
        }
      }
      if (count === 0) { resolve(null); return }
      r = Math.round(r / count); g = Math.round(g / count); b = Math.round(b / count)
      // Aumenta saturazione per renderlo più vivace
      const max = Math.max(r, g, b), min = Math.min(r, g, b)
      const boost = 1.4
      r = Math.min(255, Math.round(r + (r - (r+g+b)/3) * boost))
      g = Math.min(255, Math.round(g + (g - (r+g+b)/3) * boost))
      b = Math.min(255, Math.round(b + (b - (r+g+b)/3) * boost))
      resolve(`${r}, ${g}, ${b}`)
    }
    img.onerror = () => resolve(null)
    img.src = imageUrl
  })
}

function parseLRC(lrc) {
  if (!lrc) return []
  return lrc.split('\n').map(line => {
    const match = line.match(/\[(\d+):(\d+)[\.:](\d+)\](.*)/)
    if (!match) return null
    return {
      time: parseInt(match[1]) * 60 + parseInt(match[2]) + parseInt(match[3]) / 100,
      text: match[4].trim()
    }
  }).filter(Boolean)
}

// ─── Auth helper ────────────────────────────────────────────────────────────
function getAuthToken() { return localStorage.getItem('lyricsync_token') || '' }
function authHeaders() { return { 'X-App-Token': getAuthToken() } }

// ─── Preferenze persistenti ─────────────────────────────────────────────────
const PREFS_KEY = 'lyricsync_prefs'
function loadPrefs() {
  try { return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') } catch { return {} }
}
function savePrefs(prefs) {
  localStorage.setItem(PREFS_KEY, JSON.stringify(prefs))
}

export default function App() {
  const [authenticated, setAuthenticated] = useState(!!localStorage.getItem('lyricsync_token'))
  const [loginPassword, setLoginPassword] = useState('')
  const [loginError, setLoginError] = useState('')
  const [loginLoading, setLoginLoading] = useState(false)

  const prefs = loadPrefs()

  const [status, setStatus] = useState('idle')
  const [song, setSong] = useState(null)
  const [lyrics, setLyrics] = useState([])
  const [plainLyrics, setPlainLyrics] = useState('')
  const [currentLine, setCurrentLine] = useState(0)
  const [error, setError] = useState('')
  const [counter, setCounter] = useState({ used: 0, remaining: 500, total: 500 })
  const [voiceReady, setVoiceReady] = useState(false)
  const [history, setHistory] = useState([])
  const [showHistory, setShowHistory] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [apiKeys, setApiKeys] = useState([])
  const [newApiKey, setNewApiKey] = useState('')
  const [newApiEmail, setNewApiEmail] = useState('')
  const [keysLoading, setKeysLoading] = useState(false)
  const [fontSize, setFontSize] = useState(prefs.fontSize || DEFAULT_FONT)
  const [translatedLyrics, setTranslatedLyrics] = useState({})
  const [showTranslation, setShowTranslation] = useState(false)
  const [translating, setTranslating] = useState(false)
  const [karaokeMode, setKaraokeMode] = useState(prefs.karaokeMode || false)
  const [karaokeProgress, setKaraokeProgress] = useState(0)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [autoTranslate, setAutoTranslate] = useState(prefs.autoTranslate || false)
  const [transLang, setTransLang] = useState(prefs.transLang || 'it')
  const [elapsed, setElapsed] = useState(0)
  const [estimatedDuration, setEstimatedDuration] = useState(0)
  const [dynamicColor, setDynamicColor] = useState(null)
  const [discogsInfo, setDiscogsInfo] = useState(null)
  const [discogsLoading, setDiscogsLoading] = useState(false)
  const [discogsConfig, setDiscogsConfig] = useState({ configured: false, username: '' })
  const [discogsForm, setDiscogsForm] = useState({ username: '', consumerKey: '', consumerSecret: '' })
  const [discogsFields, setDiscogsFields] = useState({})
  const [discogsFieldsForm, setDiscogsFieldsForm] = useState({})

  const streamRef = useRef(null)
  const recognizeTimerRef = useRef(null)
  const fallbackTimerRef = useRef(null)
  const lyricsTimerRef = useRef(null)
  const silenceCheckRef = useRef(null)
  const speechRef = useRef(null)
  const consecutiveFailsRef = useRef(0)
  const lineRefs = useRef([])
  const analyserRef = useRef(null)
  const isListeningRef = useRef(false)
  const isRecognizingRef = useRef(false)
  const currentSongKeyRef = useRef(null)
  const previousSongKeyRef = useRef(null)
  const songFoundTimeRef = useRef(null)
  const autoNextTimerRef = useRef(null)
  const anchorTimeRef = useRef(null)
  const recognizeRef = useRef(null)
  const lastRecognizeRef = useRef(0)  // timestamp ultima chiamata API
  const silenceReadyRef = useRef(false)
  const silenceActiveRef = useRef(false)
  const wakeLockRef = useRef(null)

  const fetchCounter = useCallback(async () => {
    try { const res = await fetch(`${BACKEND}/counter`, { headers: authHeaders() }); setCounter(await res.json()) } catch {}
  }, [])

  useEffect(() => { fetchCounter() }, [fetchCounter])

  useEffect(() => {
    const el = lineRefs.current[currentLine]
    const container = document.querySelector('.lyrics-area')
    if (el && container) {
      const elTop = el.getBoundingClientRect().top
      const containerTop = container.getBoundingClientRect().top
      const targetOffset = container.clientHeight * 0.2
      container.scrollBy({ top: elTop - containerTop - targetOffset, behavior: 'smooth' })
    }
  }, [currentLine])

  // Estrai colore dominante dalla cover quando cambia canzone
  useEffect(() => {
    if (song?.cover) {
      extractDominantColor(song.cover).then(color => {
        if (color) {
          setDynamicColor(color)
          document.documentElement.style.setProperty('--accent', `rgb(${color})`)
          document.documentElement.style.setProperty('--accent-glow', `rgba(${color}, 0.9)`)
        }
      })
    } else {
      // Reset al colore default
      setDynamicColor(null)
      document.documentElement.style.setProperty('--accent', '#e8c97e')
      document.documentElement.style.setProperty('--accent-glow', '#f0d180')
    }
  }, [song?.shazamKey])

  // Cerca info Discogs quando cambia canzone
  useEffect(() => {
    if (!song?.artist) { setDiscogsInfo(null); return }
    let cancelled = false
    setDiscogsLoading(true)
    const params = new URLSearchParams({ artist: song.artist, title: song.title })
    if (song.album) params.append('album', song.album)
    fetch(`${BACKEND}/discogs/search?${params}`, { headers: authHeaders() })
      .then(r => r.json())
      .then(data => { if (!cancelled) setDiscogsInfo(data.found ? data : null) })
      .catch(() => { if (!cancelled) setDiscogsInfo(null) })
      .finally(() => { if (!cancelled) setDiscogsLoading(false) })
    return () => { cancelled = true }
  }, [song?.shazamKey])

  const startLyricsTick = useCallback((parsedLyrics, startTime) => {
    if (lyricsTimerRef.current) clearInterval(lyricsTimerRef.current)
    if (autoNextTimerRef.current) clearTimeout(autoNextTimerRef.current)
    anchorTimeRef.current = startTime

    // Calcola durata stimata: ultimo timestamp + 30s per l'outro
    const lastTime = parsedLyrics.length > 0 ? parsedLyrics[parsedLyrics.length - 1].time : 0
    const estDuration = lastTime > 0 ? lastTime + 30 : 0
    console.log(`⏱️ Durata stimata: ${Math.round(estDuration)}s (ultimo sync: ${lastTime.toFixed(0)}s, righe: ${parsedLyrics.length})`)
    setEstimatedDuration(estDuration)

    // Auto-next: dopo l'ultimo timestamp + 20s, forza nuovo riconoscimento
    if (lastTime > 0) {
      const now = (Date.now() - startTime) / 1000
      const timeUntilEnd = (lastTime + 20) - now
      if (timeUntilEnd > 0) {
        autoNextTimerRef.current = setTimeout(() => {
          console.log('⏭ Auto-next: testo finito, cerco prossima canzone')
          currentSongKeyRef.current = null
          silenceReadyRef.current = false
          if (fallbackTimerRef.current) clearTimeout(fallbackTimerRef.current)
          if (recognizeTimerRef.current) clearTimeout(recognizeTimerRef.current)
          isRecognizingRef.current = false
          if (streamRef.current && recognizeRef.current) recognizeRef.current(streamRef.current)
        }, timeUntilEnd * 1000)
        console.log(`⏱️ Auto-next programmato tra ${Math.round(timeUntilEnd)}s (ultimo sync: ${lastTime.toFixed(0)}s + 20s)`)
      }
    }

    lyricsTimerRef.current = setInterval(() => {
      const el = (Date.now() - startTime) / 1000
      setElapsed(el)
      let idx = 0
      for (let i = 0; i < parsedLyrics.length; i++) {
        if (parsedLyrics[i].time <= el) idx = i
        else break
      }
      setCurrentLine(idx)
      // Calcola progresso karaoke (0-100%) nella riga corrente
      const currentTime = parsedLyrics[idx]?.time || 0
      const nextTime = parsedLyrics[idx + 1]?.time || (currentTime + 5)
      const duration = nextTime - currentTime
      const progress = duration > 0 ? Math.min(100, ((el - currentTime) / duration) * 100) : 0
      setKaraokeProgress(progress)
    }, LYRICS_TICK)
  }, [])

  const fetchLyrics = useCallback(async (title, artist, album, offset, anchorTime = Date.now(), shazamKey = null) => {
    console.log(`📝 Cerco testi: "${title}" offset=${offset.toFixed(1)}s`)

    // Controlla cache prima di chiamare il backend
    if (shazamKey) {
      const cached = getFromCache(shazamKey)
      if (cached && (cached.syncedLyrics || cached.plainLyrics)) {
        console.log(`💾 Cache hit: "${title}" — uso testi dalla cache`)
        if (cached.syncedLyrics) {
          const parsed = parseLRC(cached.syncedLyrics)
          setLyrics(parsed)
          setPlainLyrics('')
          startLyricsTick(parsed, anchorTime - (offset * 1000))
          setCurrentLine(0)
        } else if (cached.plainLyrics) {
          setLyrics([])
          setPlainLyrics(cached.plainLyrics)
        }
        return
      }
    }

    try {
      const params = new URLSearchParams({ title, artist })
      if (album) params.append('album', album)
      const res = await fetch(`${BACKEND}/lyrics?${params}`, { headers: authHeaders() })
      const data = await res.json()
      if (data.found && data.syncedLyrics) {
        const parsed = parseLRC(data.syncedLyrics)
        setLyrics(parsed)
        setPlainLyrics('')
        startLyricsTick(parsed, anchorTime - (offset * 1000))
        setCurrentLine(0)
        // Salva in cache
        if (shazamKey) saveToCache(shazamKey, { title, artist, album, shazamKey }, data.syncedLyrics, null)
      } else if (data.found && data.plainLyrics) {
        setLyrics([])
        setPlainLyrics(data.plainLyrics)
        if (shazamKey) saveToCache(shazamKey, { title, artist, album, shazamKey }, null, data.plainLyrics)
      } else {
        setLyrics([])
        setPlainLyrics('')
      }
    } catch (err) {
      console.error('❌ fetchLyrics:', err)
      setLyrics([])
      setPlainLyrics('')
    }
  }, [startLyricsTick])

  const recognize = useCallback(async (stream, force = false) => {
    if (!isListeningRef.current || isRecognizingRef.current) return

    // Cooldown: impedisce chiamate troppo ravvicinate (min 12s tra una e l'altra)
    const timeSinceLast = Date.now() - lastRecognizeRef.current
    if (!force && timeSinceLast < MIN_RECOGNIZE_GAP) {
      const wait = MIN_RECOGNIZE_GAP - timeSinceLast
      console.log(`⏳ Cooldown: aspetto ${Math.round(wait/1000)}s prima della prossima chiamata`)
      recognizeTimerRef.current = setTimeout(() => recognize(stream), wait)
      return
    }

    if (force) console.log('⚡ Riconoscimento forzato (skip/voice)')

    isRecognizingRef.current = true
    // Non cambiare status a 'recognizing' se c'è già una canzone in riproduzione (evita flicker della barra)
    if (!currentSongKeyRef.current) setStatus('recognizing')
    lastRecognizeRef.current = Date.now()
    const recordStartTime = Date.now()

    try {
      const blob = await new Promise((resolve) => {
        const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm' })
        const chunks = []
        recorder.ondataavailable = e => chunks.push(e.data)
        recorder.onstop = () => resolve(new Blob(chunks, { type: 'audio/webm' }))
        recorder.start()
        setTimeout(() => { if (recorder.state === 'recording') recorder.stop() }, 5000)
      })

      if (blob.size < 1000) throw new Error('Audio troppo corto')

      const formData = new FormData()
      formData.append('audio', blob, 'chunk.webm')
      const res = await fetch(`${BACKEND}/recognize`, { method: 'POST', body: formData, headers: authHeaders() })
      if (!res.ok) throw new Error(`Backend error: ${res.status}`)
      const data = await res.json()
      const responseTime = Date.now()
      fetchCounter()

      if (data.found) {
        consecutiveFailsRef.current = 0
        const isCurrentSong = data.shazamKey === currentSongKeyRef.current
        const isSameAsPrevious = data.shazamKey === previousSongKeyRef.current
        const recentlyFound = songFoundTimeRef.current && (Date.now() - songFoundTimeRef.current) < FALLBACK_TIMEOUT

        if (isCurrentSong) {
          console.log('🔄 Stessa canzone, nessuna azione')
          setStatus('playing')
        } else if (isSameAsPrevious && recentlyFound) {
          console.log('🔄 Stessa canzone dopo pausa — ripristino senza sprecare chiamate')
          currentSongKeyRef.current = data.shazamKey
          silenceReadyRef.current = false
          silenceActiveRef.current = false
          setStatus('playing')
          // Cooldown lungo (60s) prima di ri-attivare silence detection — evita loop di riconoscimenti
          setTimeout(() => {
            if (currentSongKeyRef.current === data.shazamKey) {
              silenceReadyRef.current = true
              console.log('🔇 Silence detection ri-attivata (dopo same-song cooldown 60s)')
            }
          }, 60000)
        } else {
          // NUOVA canzone davvero
          const totalDelay = (responseTime - recordStartTime) / 1000
          const actualOffset = (data.timeskip || 0) + totalDelay
          console.log(`🎵 ${data.title} | shazam: ${data.timeskip?.toFixed(1)}s + delay: ${totalDelay.toFixed(1)}s = ${actualOffset.toFixed(1)}s`)

          currentSongKeyRef.current = data.shazamKey
          previousSongKeyRef.current = data.shazamKey
          songFoundTimeRef.current = Date.now()
          silenceReadyRef.current = false
          silenceActiveRef.current = false
          if (autoNextTimerRef.current) clearTimeout(autoNextTimerRef.current)
          setElapsed(0)
          setEstimatedDuration(0)

          saveToCache(data.shazamKey, data, null, null)

          setSong(data)
          setCurrentLine(0)
          setLyrics([])
          setPlainLyrics('')
          setTranslatedLyrics({})
          setShowTranslation(false)
          if (lyricsTimerRef.current) clearInterval(lyricsTimerRef.current)
          setStatus('playing')

          setHistory(prev => {
            const already = prev.find(s => s.shazamKey === data.shazamKey)
            if (already) return prev
            return [{ ...data, time: new Date().toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }) }, ...prev].slice(0, 30)
          })

          setTimeout(() => {
            if (currentSongKeyRef.current === data.shazamKey) {
              silenceReadyRef.current = true
              console.log('🔇 Silence detection attivata')
            }
          }, MIN_PLAY_TIME)

          await fetchLyrics(data.title, data.artist, data.album, actualOffset, responseTime, data.shazamKey)
        }

        // Dopo riconoscimento riuscito: solo fallback timer, NESSUN retry automatico
        if (fallbackTimerRef.current) clearTimeout(fallbackTimerRef.current)
        fallbackTimerRef.current = setTimeout(() => {
          console.log('⏰ Fallback 6 min — forzo nuovo riconoscimento')
          currentSongKeyRef.current = null
          previousSongKeyRef.current = null
          silenceReadyRef.current = false
          isRecognizingRef.current = false
          recognize(stream)
        }, FALLBACK_TIMEOUT)

      } else {
        consecutiveFailsRef.current += 1

        // Se una canzone è già in riproduzione, NON ritentare — aspetta auto-next o silenzio
        if (currentSongKeyRef.current) {
          console.log('🔍 Non trovata, ma canzone in corso — aspetto auto-next/silenzio')
          setStatus('playing')
          isRecognizingRef.current = false
          return
        }

        // Backoff esponenziale: 20s, 30s, 60s, 120s, 240s, max 300s
        const fails = consecutiveFailsRef.current
        const delay = fails <= 1
          ? INTERVAL_SEARCHING
          : Math.min(FAIL_BACKOFF_BASE * Math.pow(2, fails - MAX_CONSECUTIVE_FAILS), FAIL_BACKOFF_MAX)
        console.log(`🔍 Non trovata (tentativo ${fails}, prossimo tra ${Math.round(delay/1000)}s)`)
        setStatus('listening')
        recognizeTimerRef.current = setTimeout(() => {
          isRecognizingRef.current = false
          recognize(stream)
        }, delay)
        return
      }
    } catch (err) {
      consecutiveFailsRef.current += 1
      console.error('❌ recognize:', err.message)

      // Come sopra: se canzone in corso, non ritentare
      if (currentSongKeyRef.current) {
        setStatus('playing')
        isRecognizingRef.current = false
        return
      }

      const fails = consecutiveFailsRef.current
      const delay = fails <= 1
        ? INTERVAL_SEARCHING
        : Math.min(FAIL_BACKOFF_BASE * Math.pow(2, fails - MAX_CONSECUTIVE_FAILS), FAIL_BACKOFF_MAX)
      setStatus('listening')
      recognizeTimerRef.current = setTimeout(() => {
        isRecognizingRef.current = false
        recognize(stream)
      }, delay)
      return
    }

    isRecognizingRef.current = false
  }, [fetchCounter, fetchLyrics])

  // Mantieni ref aggiornato per evitare dipendenza circolare con startLyricsTick
  useEffect(() => { recognizeRef.current = recognize }, [recognize])

  const startSilenceDetection = useCallback((stream) => {
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)()
    const source = audioCtx.createMediaStreamSource(stream)
    const analyser = audioCtx.createAnalyser()
    analyser.fftSize = 1024
    source.connect(analyser)
    analyserRef.current = analyser
    const dataArray = new Uint8Array(analyser.frequencyBinCount)
    let silenceStart = null

    let logCounter = 0
    silenceCheckRef.current = setInterval(() => {
      if (!isListeningRef.current) return
      analyser.getByteTimeDomainData(dataArray)
      let sum = 0
      for (let i = 0; i < dataArray.length; i++) {
        const val = (dataArray[i] - 128) / 128
        sum += val * val
      }
      const rms = Math.sqrt(sum / dataArray.length)

      // Log livello audio ogni ~3 secondi per debug (10 * 300ms)
      logCounter++
      if (logCounter % 10 === 0) {
        console.log(`📊 Audio RMS: ${rms.toFixed(4)} | soglia: ${SILENCE_THRESHOLD} | silenceReady: ${silenceReadyRef.current} | silenceActive: ${silenceActiveRef.current}`)
      }

      // FASE 1: Se silenzio è già stato rilevato, controlla se l'audio è ripreso
      // (questo deve funzionare INDIPENDENTEMENTE da silenceReady)
      if (silenceActiveRef.current) {
        if (rms >= SILENCE_THRESHOLD) {
          console.log(`🎵 Audio ripreso (RMS: ${rms.toFixed(4)}) — riconosco nuova canzone...`)
          silenceActiveRef.current = false
          silenceStart = null
          currentSongKeyRef.current = null  // reset qui, quando l'audio riprende davvero
          isRecognizingRef.current = false
          recognize(stream, true)
        }
        return
      }

      // FASE 2: Cerca inizio silenzio (solo quando silenceReady è attivo)
      if (!silenceReadyRef.current || isRecognizingRef.current) return

      if (rms < SILENCE_THRESHOLD) {
        if (!silenceStart) { silenceStart = Date.now(); console.log(`🔇 Inizio silenzio (RMS: ${rms.toFixed(4)})`) }
        if ((Date.now() - silenceStart) > SILENCE_DURATION) {
          console.log(`🔇 Silenzio confermato dopo ${SILENCE_DURATION}ms — pronto per prossima canzone`)
          silenceActiveRef.current = true
          silenceReadyRef.current = false
          // NON resettare currentSongKeyRef qui — lo faremo solo quando l'audio riprende
          // Così se è un falso positivo (passaggio tranquillo), la canzone non viene "dimenticata"
          if (fallbackTimerRef.current) clearTimeout(fallbackTimerRef.current)
          if (recognizeTimerRef.current) clearTimeout(recognizeTimerRef.current)
          if (autoNextTimerRef.current) clearTimeout(autoNextTimerRef.current)
          setStatus('listening')
        }
      } else {
        silenceStart = null
      }
    }, 300)
  }, [recognize])

  const startVoiceCommand = useCallback((stream) => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SR) return
    const speech = new SR()
    speech.lang = 'it-IT'
    speech.continuous = true
    speech.interimResults = false
    speech.onresult = (event) => {
      const t = event.results[event.results.length - 1][0].transcript.toLowerCase().trim()
      if (t.includes('aggiorna') || t.includes('prossima') || t.includes('next')) {
        console.log('🎤 Comando vocale!')
        currentSongKeyRef.current = null
        silenceReadyRef.current = false
        if (fallbackTimerRef.current) clearTimeout(fallbackTimerRef.current)
        if (recognizeTimerRef.current) clearTimeout(recognizeTimerRef.current)
        isRecognizingRef.current = false
        silenceActiveRef.current = false
        recognize(stream, true)
      }
    }
    speech.onerror = () => {}
    speech.onend = () => { if (isListeningRef.current) { try { speech.start() } catch {} } }
    try { speech.start(); speechRef.current = speech; setVoiceReady(true) } catch {}
  }, [recognize])

  const forceNextSong = useCallback(() => {
    if (!streamRef.current) return
    console.log('⏭ Skip manuale')
    currentSongKeyRef.current = null
    silenceReadyRef.current = false
    silenceActiveRef.current = false
    if (fallbackTimerRef.current) clearTimeout(fallbackTimerRef.current)
    if (recognizeTimerRef.current) clearTimeout(recognizeTimerRef.current)
    isRecognizingRef.current = false
    recognize(streamRef.current, true)
  }, [recognize])

  const startListening = useCallback(async () => {
    try {
      setError('')
      setStatus('listening')
      isListeningRef.current = true
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream
      startSilenceDetection(stream)
      startVoiceCommand(stream)
      // Keep screen on (Wake Lock API)
      try {
        if ('wakeLock' in navigator) {
          wakeLockRef.current = await navigator.wakeLock.request('screen')
          console.log('🔆 Wake Lock attivato — schermo sempre acceso')
          wakeLockRef.current.addEventListener('release', () => console.log('🔆 Wake Lock rilasciato'))
        }
      } catch (e) { console.warn('Wake Lock non disponibile:', e) }
      setTimeout(() => recognize(stream), 500)
    } catch {
      setError('Microfono non disponibile. Controlla i permessi del browser.')
      setStatus('idle')
    }
  }, [recognize, startSilenceDetection, startVoiceCommand])

  const stopListening = useCallback(() => {
    isListeningRef.current = false
    isRecognizingRef.current = false
    if (recognizeTimerRef.current) clearTimeout(recognizeTimerRef.current)
    if (fallbackTimerRef.current) clearTimeout(fallbackTimerRef.current)
    if (autoNextTimerRef.current) clearTimeout(autoNextTimerRef.current)
    if (lyricsTimerRef.current) clearInterval(lyricsTimerRef.current)
    if (silenceCheckRef.current) clearInterval(silenceCheckRef.current)
    if (speechRef.current) { try { speechRef.current.stop() } catch {} }
    streamRef.current?.getTracks().forEach(t => t.stop())
    // Rilascia Wake Lock
    if (wakeLockRef.current) { try { wakeLockRef.current.release(); wakeLockRef.current = null } catch {} }
    currentSongKeyRef.current = null
    previousSongKeyRef.current = null
    songFoundTimeRef.current = null
    silenceReadyRef.current = false
    silenceActiveRef.current = false
    setStatus('idle')
    setVoiceReady(false)
  }, [])

  useEffect(() => () => stopListening(), [stopListening])

  // Re-acquire Wake Lock quando il tab torna visibile
  useEffect(() => {
    const handleVisibility = async () => {
      if (document.visibilityState === 'visible' && isListeningRef.current && !wakeLockRef.current) {
        try {
          if ('wakeLock' in navigator) {
            wakeLockRef.current = await navigator.wakeLock.request('screen')
            console.log('🔆 Wake Lock ri-attivato')
          }
        } catch {}
      }
    }
    document.addEventListener('visibilitychange', handleVisibility)
    return () => document.removeEventListener('visibilitychange', handleVisibility)
  }, [])

  const toggleFullscreen = useCallback(() => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {})
    } else {
      document.exitFullscreen().catch(() => {})
    }
  }, [])

  useEffect(() => {
    const handler = () => setIsFullscreen(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', handler)
    return () => document.removeEventListener('fullscreenchange', handler)
  }, [])

  const translateLyrics = useCallback(async () => {
    if (translating) return
    if (!showTranslation && Object.keys(translatedLyrics).length > 0 && translatedLyrics._songKey === song?.shazamKey) {
      setShowTranslation(true)
      return
    }
    // Raccogli testo da tradurre
    let textToTranslate = ''
    if (lyrics.length > 0) {
      textToTranslate = lyrics.map(l => l.text).filter(Boolean).join('\n')
    } else if (plainLyrics) {
      textToTranslate = plainLyrics
    }
    if (!textToTranslate) return

    setTranslating(true)
    try {
      const res = await fetch(`${BACKEND}/translate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ text: textToTranslate, targetLang: transLang })
      })
      const data = await res.json()
      if (data.translated) {
        const lines = data.translated.split('\n')
        const map = { _songKey: song?.shazamKey }
        lines.forEach((line, i) => { map[i] = line })
        setTranslatedLyrics(map)
        setShowTranslation(true)
      }
    } catch (err) {
      console.error('❌ translateLyrics:', err)
    }
    setTranslating(false)
  }, [translating, showTranslation, translatedLyrics, lyrics, plainLyrics, song, transLang])

  const formatTime = (seconds) => {
    if (!seconds || seconds < 0) return '0:00'
    const m = Math.floor(seconds / 60)
    const s = Math.floor(seconds % 60)
    return `${m}:${s.toString().padStart(2, '0')}`
  }

  const statusLabel = {
    idle: 'Premi play per iniziare',
    listening: 'In ascolto...',
    recognizing: 'Riconosco la canzone...',
    playing: 'In riproduzione'
  }[status]

  const isActive = status !== 'idle'

  const fetchApiKeys = useCallback(async () => {
    try {
      const res = await fetch(`${BACKEND}/keys`, { headers: authHeaders() })
      if (res.ok) setApiKeys((await res.json()).keys || [])
    } catch {}
  }, [])

  const addApiKey = async () => {
    if (!newApiKey.trim() || keysLoading) return
    setKeysLoading(true)
    try {
      const res = await fetch(`${BACKEND}/keys`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ key: newApiKey.trim(), email: newApiEmail.trim() })
      })
      const data = await res.json()
      if (res.ok) { setNewApiKey(''); setNewApiEmail(''); await fetchApiKeys(); fetchCounter() }
      else alert(data.error || 'Errore')
    } catch { alert('Errore di connessione') }
    setKeysLoading(false)
  }

  const removeApiKey = async (index) => {
    if (keysLoading) return
    setKeysLoading(true)
    try {
      const res = await fetch(`${BACKEND}/keys/${index}`, { method: 'DELETE', headers: authHeaders() })
      const data = await res.json()
      if (res.ok) { await fetchApiKeys(); fetchCounter() }
      else alert(data.error || 'Errore')
    } catch { alert('Errore di connessione') }
    setKeysLoading(false)
  }

  // Carica chiavi e config Discogs quando si apre il pannello impostazioni
  useEffect(() => {
    if (showSettings && authenticated) {
      fetchApiKeys()
      // Carica config Discogs
      fetch(`${BACKEND}/discogs/config`, { headers: authHeaders() })
        .then(r => r.json())
        .then(data => {
          setDiscogsConfig(data)
          if (data.username) setDiscogsForm(f => ({ ...f, username: data.username }))
        })
        .catch(() => {})
      // Carica nomi campi personalizzati
      fetch(`${BACKEND}/discogs/fields`, { headers: authHeaders() })
        .then(r => r.json())
        .then(data => {
          setDiscogsFields(data.fields || {})
          setDiscogsFieldsForm(data.fields || {})
        })
        .catch(() => {})
    }
  }, [showSettings, authenticated, fetchApiKeys])

  const handleLogin = async (e) => {
    e.preventDefault()
    setLoginLoading(true)
    setLoginError('')
    try {
      const res = await fetch(`${BACKEND}/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: loginPassword })
      })
      const data = await res.json()
      if (data.ok) {
        localStorage.setItem('lyricsync_token', loginPassword)
        setAuthenticated(true)
      } else {
        setLoginError('Password errata')
      }
    } catch {
      setLoginError('Errore di connessione al server')
    }
    setLoginLoading(false)
  }

  const handleLogout = () => {
    localStorage.removeItem('lyricsync_token')
    setAuthenticated(false)
    setLoginPassword('')
    stopListening()
  }

  // ─── Schermata di login ─────────────────────────────────────────────────────
  if (!authenticated) {
    return (
      <div className="app">
        <div className="overlay" />
        <div className="login-screen">
          <div className="login-icon">♫</div>
          <h1 className="login-title">LyricSync</h1>
          <p className="login-subtitle">Inserisci la password per accedere</p>
          <form onSubmit={handleLogin} className="login-form">
            <input
              type="password"
              value={loginPassword}
              onChange={e => setLoginPassword(e.target.value)}
              placeholder="Password"
              className="login-input"
              autoFocus
            />
            <button type="submit" className="login-btn" disabled={loginLoading || !loginPassword}>
              {loginLoading ? '...' : 'Accedi'}
            </button>
          </form>
          {loginError && <p className="login-error">{loginError}</p>}
        </div>
      </div>
    )
  }

  return (
    <div className="app">
      {/* Sfondo artista a tutto schermo — usa cover come fallback */}
      {(song?.artistImage || song?.cover) && (
        <img
          src={song.artistImage || song.cover}
          alt=""
          className="bg-artist"
          onError={(e) => { if (song?.cover && e.target.src !== song.cover) e.target.src = song.cover }}
        />
      )}
      <div className="overlay" />

      {/* Pannello cronologia */}
      {showHistory && (
        <div className="history-panel">
          <div className="history-header">
            <span>Cronologia</span>
            <button className="history-close" onClick={() => setShowHistory(false)}>✕</button>
          </div>
          {history.length === 0 ? (
            <p className="history-empty">Nessuna canzone ancora</p>
          ) : (
            history.map((s, i) => (
              <div key={i} className="history-item">
                {s.cover && <img src={s.cover} alt="" className="history-cover" />}
                <div className="history-meta">
                  <span className="history-title">{s.title}</span>
                  <span className="history-artist">{s.artist}</span>
                </div>
                <span className="history-time">{s.time}</span>
              </div>
            ))
          )}
        </div>
      )}

      {/* Pannello impostazioni */}
      {showSettings && (
        <div className="settings-panel">
          <div className="settings-header">
            <span>Impostazioni</span>
            <button className="history-close" onClick={() => setShowSettings(false)}>✕</button>
          </div>

          <div className="settings-group">
            <label className="settings-label">Dimensione testo</label>
            <div className="settings-row">
              <input type="range" min={MIN_FONT} max={MAX_FONT} value={fontSize}
                onChange={e => { const v = Number(e.target.value); setFontSize(v); savePrefs({ ...loadPrefs(), fontSize: v }) }}
                className="settings-range" />
              <span className="settings-value">{fontSize}px</span>
            </div>
          </div>

          <div className="settings-group">
            <label className="settings-label">Modalità karaoke</label>
            <div className="settings-row">
              <button className={`settings-toggle ${karaokeMode ? 'on' : ''}`}
                onClick={() => { const v = !karaokeMode; setKaraokeMode(v); savePrefs({ ...loadPrefs(), karaokeMode: v }) }}>
                {karaokeMode ? 'ON' : 'OFF'}
              </button>
            </div>
          </div>

          <div className="settings-group">
            <label className="settings-label">Traduzione automatica</label>
            <div className="settings-row">
              <button className={`settings-toggle ${autoTranslate ? 'on' : ''}`}
                onClick={() => { const v = !autoTranslate; setAutoTranslate(v); savePrefs({ ...loadPrefs(), autoTranslate: v }) }}>
                {autoTranslate ? 'ON' : 'OFF'}
              </button>
            </div>
          </div>

          <div className="settings-group">
            <label className="settings-label">Lingua traduzione</label>
            <div className="settings-row">
              <select value={transLang} className="settings-select"
                onChange={e => { const v = e.target.value; setTransLang(v); savePrefs({ ...loadPrefs(), transLang: v }) }}>
                <option value="it">Italiano</option>
                <option value="es">Español</option>
                <option value="fr">Français</option>
                <option value="de">Deutsch</option>
                <option value="pt">Português</option>
                <option value="ja">日本語</option>
              </select>
            </div>
          </div>

          <div className="settings-group">
            <label className="settings-label">Chiavi API Shazam ({apiKeys.length})</label>
            {apiKeys.map((k, i) => (
              <div key={i} className="settings-key-card">
                <div className="settings-key-row">
                  <span className="settings-key-name">{k.prefix}</span>
                  <span className="settings-key-source">{k.source}</span>
                  <span className={`settings-key-status ${k.exhausted ? 'exhausted' : ''}`}>
                    {k.exhausted ? 'esaurita' : `${k.remaining} rimaste`}
                  </span>
                  {k.source === 'redis' && (
                    <button className="settings-key-remove" onClick={() => removeApiKey(k.index)} disabled={keysLoading}>✕</button>
                  )}
                </div>
                {(k.email || k.addedAt) && (
                  <div className="settings-key-meta">
                    {k.email && <span>{k.email}</span>}
                    {k.addedAt && <span>aggiunta il {k.addedAt}</span>}
                  </div>
                )}
              </div>
            ))}
            <div className="settings-add-key">
              <input type="text" value={newApiKey} onChange={e => setNewApiKey(e.target.value)}
                placeholder="Chiave RapidAPI" className="settings-key-input"
                onKeyDown={e => e.key === 'Enter' && addApiKey()} />
              <input type="email" value={newApiEmail} onChange={e => setNewApiEmail(e.target.value)}
                placeholder="Email account RapidAPI" className="settings-key-input"
                onKeyDown={e => e.key === 'Enter' && addApiKey()} />
              <button className="settings-btn-small" onClick={addApiKey} disabled={keysLoading || !newApiKey.trim()}>
                {keysLoading ? '...' : '+ Aggiungi'}
              </button>
            </div>
          </div>

          <div className="settings-group">
            <label className="settings-label">Discogs</label>
            {discogsConfig.configured ? (
              <div className="settings-discogs-status">
                <span className="discogs-connected">Collegato come <strong>{discogsConfig.username}</strong></span>
                <button className="settings-btn-small" onClick={async () => {
                  try {
                    await fetch(`${BACKEND}/discogs/config`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify({ username: '', consumerKey: '', consumerSecret: '' }) })
                    setDiscogsConfig({ configured: false, username: '' })
                    setDiscogsForm({ username: '', consumerKey: '', consumerSecret: '' })
                  } catch {}
                }}>Disconnetti</button>
              </div>
            ) : (
              <div className="settings-discogs-form">
                <input type="text" value={discogsForm.username} onChange={e => setDiscogsForm(f => ({ ...f, username: e.target.value }))}
                  placeholder="Username Discogs" className="settings-key-input" />
                <input type="text" value={discogsForm.consumerKey} onChange={e => setDiscogsForm(f => ({ ...f, consumerKey: e.target.value }))}
                  placeholder="Consumer Key" className="settings-key-input" />
                <input type="password" value={discogsForm.consumerSecret} onChange={e => setDiscogsForm(f => ({ ...f, consumerSecret: e.target.value }))}
                  placeholder="Consumer Secret" className="settings-key-input" />
                <button className="settings-btn-small" disabled={!discogsForm.username || !discogsForm.consumerKey || !discogsForm.consumerSecret}
                  onClick={async () => {
                    try {
                      const res = await fetch(`${BACKEND}/discogs/config`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', ...authHeaders() },
                        body: JSON.stringify(discogsForm)
                      })
                      if (res.ok) {
                        setDiscogsConfig({ configured: true, username: discogsForm.username })
                      } else {
                        const data = await res.json()
                        alert(data.error || 'Errore')
                      }
                    } catch { alert('Errore di connessione') }
                  }}>Collega Discogs</button>
              </div>
            )}
            {discogsConfig.configured && (
              <div className="settings-discogs-fields">
                <p className="settings-hint">Nomi campi personalizzati (dalla tua collezione Discogs)</p>
                {[1,2,3,4,5,6].map(id => (
                  <div key={id} className="settings-field-row">
                    <span className="settings-field-id">{id}</span>
                    <input type="text" value={discogsFieldsForm[id] || ''}
                      onChange={e => setDiscogsFieldsForm(f => ({ ...f, [id]: e.target.value }))}
                      placeholder={`Campo ${id}`}
                      className="settings-key-input" />
                  </div>
                ))}
                <button className="settings-btn-small" onClick={async () => {
                  // Rimuovi campi vuoti
                  const cleaned = {};
                  for (const [k, v] of Object.entries(discogsFieldsForm)) {
                    if (v && v.trim()) cleaned[k] = v.trim();
                  }
                  try {
                    const res = await fetch(`${BACKEND}/discogs/fields`, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json', ...authHeaders() },
                      body: JSON.stringify({ fields: cleaned })
                    });
                    if (res.ok) { setDiscogsFields(cleaned); alert('Nomi campi salvati') }
                    else alert('Errore nel salvataggio')
                  } catch { alert('Errore di connessione') }
                }}>Salva nomi campi</button>
              </div>
            )}
          </div>

          <div className="settings-group">
            <label className="settings-label">Cache locale</label>
            <div className="settings-row">
              <span className="settings-value">{Object.keys(getCache()).length} canzoni</span>
              <button className="settings-btn-small" onClick={() => { localStorage.removeItem(CACHE_KEY); alert('Cache svuotata') }}>Svuota</button>
            </div>
          </div>

          <div className="settings-group settings-logout">
            <button className="settings-btn-danger" onClick={handleLogout}>Esci (Logout)</button>
          </div>
        </div>
      )}

      {/* Header */}
      <header className="song-header">
        {/* Cover grande */}
        {song?.cover ? (
          <img src={song.cover} alt="album cover" className="cover-large" loading="lazy" />
        ) : (
          <div style={{
            width: '140px',
            height: '140px',
            borderRadius: '8px',
            background: 'linear-gradient(135deg, rgba(232,201,126,0.1) 0%, rgba(232,201,126,0.05) 100%)',
            border: '1.5px solid rgba(232,201,126,0.15)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '3rem',
            opacity: 0.3,
            flexShrink: 0,
          }}>♫</div>
        )}
        <div className={`song-meta ${song ? 'visible' : ''}`}>
          {song ? (
            <>
              <h1 className="song-title">{song.title}</h1>
              <p className="song-artist">{song.artist}</p>
              <p className="song-album">{song.album}{song.album && song.year ? ' · ' : ''}{song.year}</p>
              <div className="song-links">
                <a href={`https://open.spotify.com/search/${encodeURIComponent(song.title + ' ' + song.artist)}`}
                  target="_blank" rel="noopener noreferrer" className="song-link spotify">
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.42 1.56-.299.421-1.02.599-1.559.3z"/></svg>
                  Spotify
                </a>
                <a href={`https://www.youtube.com/results?search_query=${encodeURIComponent(song.title + ' ' + song.artist)}`}
                  target="_blank" rel="noopener noreferrer" className="song-link youtube">
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/></svg>
                  YouTube
                </a>
              </div>
            </>
          ) : (
            <h1 className="song-title placeholder">LyricSync</h1>
          )}
        </div>
        <div className="header-actions">
          {status === 'playing' && (
            <button className="icon-btn" onClick={forceNextSong} title="Prossima canzone" aria-label="Skip to next song">⏭</button>
          )}
          <button className="icon-btn" onClick={() => setShowHistory(h => !h)} title="Cronologia" aria-label="View history">🕒</button>
          <button className="icon-btn" onClick={toggleFullscreen} title={isFullscreen ? 'Esci da schermo intero' : 'Schermo intero'} aria-label="Toggle fullscreen">
            {isFullscreen ? '⊡' : '⛶'}
          </button>
          <button className="icon-btn" onClick={() => setShowSettings(s => !s)} title="Impostazioni" aria-label="Settings">⚙</button>
        </div>
      </header>

      {/* Progress bar sotto l'header */}
      {estimatedDuration > 0 && song && status !== 'idle' && (
        <div className="song-progress-container">
          <span className="song-time">{formatTime(elapsed)}</span>
          <div className="progress-bar">
            <div className="progress-fill" style={{ width: `${Math.min(100, (elapsed / estimatedDuration) * 100)}%` }} />
          </div>
          <span className="song-time">~{formatTime(estimatedDuration)}</span>
        </div>
      )}

      {/* Info Discogs */}
      {discogsInfo && (
        <div className="discogs-bar-wrap">
          <a href={discogsInfo.discogsUrl} target="_blank" rel="noopener noreferrer" className="discogs-bar">
            <span className="discogs-badge">{discogsInfo.inCollection ? '💿 In collezione' : '💿 Discogs'}</span>
            <span className="discogs-details">
              {discogsInfo.label && <span>{discogsInfo.label}</span>}
              {discogsInfo.year && <span>{discogsInfo.year}</span>}
              {discogsInfo.format && <span>{discogsInfo.format}</span>}
              {discogsInfo.catno && <span className="discogs-catno">{discogsInfo.catno}</span>}
            </span>
            {discogsInfo.rating > 0 && (
              <span className="discogs-rating">{'★'.repeat(discogsInfo.rating)}{'☆'.repeat(5 - discogsInfo.rating)}</span>
            )}
          </a>
          {discogsInfo.notes && discogsInfo.notes.length > 0 && (
            <div className="discogs-notes">
              {discogsInfo.notes.map((n, i) => (
                <span key={i} className="discogs-note"><strong>{n.fieldName}:</strong> {n.value}</span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Area testi */}
      <main className="lyrics-area">
        {lyrics.length > 0 && (
          <div className="lyrics-synced">
            {lyrics.map((line, i) => (
              <div key={i} ref={el => (lineRefs.current[i] = el)} className="lyric-block">
                <p style={{
                    fontSize: i === currentLine ? `${Math.round(fontSize * 1.35)}px` : `${fontSize}px`,
                    ...(karaokeMode && i === currentLine ? {
                      backgroundImage: `linear-gradient(90deg, var(--accent-glow, #f0d180) ${karaokeProgress}%, var(--text-faded, rgba(240,237,232,0.35)) ${karaokeProgress}%)`,
                      WebkitBackgroundClip: 'text',
                      WebkitTextFillColor: 'transparent',
                      backgroundClip: 'text',
                    } : {})
                  }}
                  className={`lyric-line ${i === currentLine ? 'active' : ''} ${i < currentLine ? 'past' : ''} ${karaokeMode ? 'karaoke' : ''}`}
                  aria-current={i === currentLine ? 'line' : undefined}>
                  {line.text || '·'}
                </p>
                {showTranslation && translatedLyrics[i] && (
                  <p className={`lyric-translation ${i === currentLine ? 'active' : ''} ${i < currentLine ? 'past' : ''}`}
                    style={{ fontSize: `${Math.max(fontSize - 4, MIN_FONT)}px` }}>
                    {translatedLyrics[i]}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
        {plainLyrics && !lyrics.length && (
          <div className="lyrics-plain">
            {plainLyrics.split('\n').map((line, i) => (
              <p key={i} style={{ fontSize: `${fontSize - 4}px` }}
                className={`lyric-line-plain ${!line ? 'spacer' : ''}`}>{line || ' '}</p>
            ))}
          </div>
        )}
        {!lyrics.length && !plainLyrics && status === 'playing' && (
          <div className="no-lyrics"><span>Testo non disponibile</span></div>
        )}
        {status === 'idle' && !song && (
          <div className="welcome">
            <div className="welcome-icon">♫</div>
            <p>Ascolta e scopri il testo di qualsiasi canzone in tempo reale</p>
            <p className="welcome-hint">Dì <strong>"aggiorna"</strong> o <strong>"prossima"</strong> per cambiare canzone</p>
          </div>
        )}
        {(status === 'listening' || status === 'recognizing') && !song && (
          <div className="searching">
            <div className="pulse-ring" />
            <div className="pulse-ring delay" />
            <span className="searching-text">{statusLabel}</span>
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="footer">
        {error && <p className="error-msg">{error}</p>}
        <div className="footer-top">
          {/* Controllo font */}
          <div className="font-control">
            <button className="font-btn" onClick={() => setFontSize(f => Math.max(MIN_FONT, f - 2))}>A−</button>
            <button className="font-btn" onClick={() => setFontSize(DEFAULT_FONT)}>A</button>
            <button className="font-btn" onClick={() => setFontSize(f => Math.min(MAX_FONT, f + 2))}>A+</button>
            {lyrics.length > 0 && (
              <button className={`font-btn karaoke-btn ${karaokeMode ? 'active' : ''}`}
                onClick={() => setKaraokeMode(k => !k)}
                title="Modalità karaoke">
                K
              </button>
            )}
            {(lyrics.length > 0 || plainLyrics) && (
              <button className={`font-btn translate-btn ${showTranslation ? 'active' : ''}`}
                onClick={() => showTranslation ? setShowTranslation(false) : translateLyrics()}
                disabled={translating}>
                {translating ? '...' : transLang.toUpperCase()}
              </button>
            )}
          </div>
          <div className="status-row">
            {isActive && <span className={`status-dot ${status}`} />}
            <span className="status-label">{statusLabel}</span>
            {voiceReady && <span className="voice-badge">🎤</span>}
          </div>
        </div>
        <button className={`main-btn ${isActive ? 'active' : ''}`}
          onClick={isActive ? stopListening : startListening}>
          {isActive ? '⏹ Stop' : '▶ Inizia ad ascoltare'}
        </button>
      </footer>

      {/* Contatore chiamate */}
      <div className={`calls-counter ${counter.remaining < 50 ? 'warning' : ''}`}>
        <span className="calls-num">{counter.remaining}</span>
        <span className="calls-label">chiamate rimaste</span>
      </div>
    </div>
  )
}
