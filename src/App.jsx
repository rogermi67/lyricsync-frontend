import { useState, useEffect, useRef, useCallback } from 'react'
import './App.css'

const BACKEND = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001'
const INTERVAL_SEARCHING = 15000
const INTERVAL_SEARCHING_FAST = 8000
const FALLBACK_TIMEOUT = 360000
const LYRICS_TICK = 250
const SILENCE_THRESHOLD = 0.01
const SILENCE_DURATION = 5000
const MIN_PLAY_TIME = 15000
const MAX_CONSECUTIVE_FAILS = 3
const FAIL_BACKOFF = 30000
const MIN_FONT = 12
const MAX_FONT = 32
const DEFAULT_FONT = 20

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

export default function App() {
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
  const [fontSize, setFontSize] = useState(DEFAULT_FONT)
  const [translatedLyrics, setTranslatedLyrics] = useState({})
  const [showTranslation, setShowTranslation] = useState(false)
  const [translating, setTranslating] = useState(false)
  const [karaokeMode, setKaraokeMode] = useState(false)
  const [karaokeProgress, setKaraokeProgress] = useState(0)
  const [elapsed, setElapsed] = useState(0)
  const [estimatedDuration, setEstimatedDuration] = useState(0)

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
  const silenceReadyRef = useRef(false)
  const silenceActiveRef = useRef(false)

  const fetchCounter = useCallback(async () => {
    try { const res = await fetch(`${BACKEND}/counter`); setCounter(await res.json()) } catch {}
  }, [])

  useEffect(() => { fetchCounter() }, [fetchCounter])

  useEffect(() => {
    lineRefs.current[currentLine]?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [currentLine])

  const startLyricsTick = useCallback((parsedLyrics, startTime) => {
    if (lyricsTimerRef.current) clearInterval(lyricsTimerRef.current)
    if (autoNextTimerRef.current) clearTimeout(autoNextTimerRef.current)
    anchorTimeRef.current = startTime

    // Calcola durata stimata: ultimo timestamp + 30s per l'outro
    const lastTime = parsedLyrics.length > 0 ? parsedLyrics[parsedLyrics.length - 1].time : 0
    const estDuration = lastTime > 0 ? lastTime + 30 : 0
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

  const fetchLyrics = useCallback(async (title, artist, album, offset, anchorTime = Date.now()) => {
    console.log(`📝 Cerco testi: "${title}" offset=${offset.toFixed(1)}s`)
    try {
      const params = new URLSearchParams({ title, artist })
      if (album) params.append('album', album)
      const res = await fetch(`${BACKEND}/lyrics?${params}`)
      const data = await res.json()
      if (data.found && data.syncedLyrics) {
        const parsed = parseLRC(data.syncedLyrics)
        setLyrics(parsed)
        setPlainLyrics('')
        startLyricsTick(parsed, anchorTime - (offset * 1000))
        setCurrentLine(0)
      } else if (data.found && data.plainLyrics) {
        setLyrics([])
        setPlainLyrics(data.plainLyrics)
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
    if (force) console.log('⚡ Riconoscimento forzato (skip/voice)')

    isRecognizingRef.current = true
    setStatus('recognizing')
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
      const res = await fetch(`${BACKEND}/recognize`, { method: 'POST', body: formData })
      if (!res.ok) throw new Error(`Backend error: ${res.status}`)
      const data = await res.json()
      const responseTime = Date.now()
      fetchCounter()

      if (data.found) {
        consecutiveFailsRef.current = 0
        // Controlla se è la stessa canzone (anche dopo reset da silence detection)
        const isCurrentSong = data.shazamKey === currentSongKeyRef.current
        const isSameAsPrevious = data.shazamKey === previousSongKeyRef.current
        const recentlyFound = songFoundTimeRef.current && (Date.now() - songFoundTimeRef.current) < FALLBACK_TIMEOUT

        if (isCurrentSong) {
          // Stessa canzone in corso — non fare nulla
          console.log('🔄 Stessa canzone, nessuna azione')
          setStatus('playing')
        } else if (isSameAsPrevious && recentlyFound) {
          // Silence detection ha triggerato ma è sempre la stessa canzone
          // Ripristina lo stato senza ri-caricare testi
          console.log('🔄 Stessa canzone dopo pausa — ripristino senza sprecare chiamate')
          currentSongKeyRef.current = data.shazamKey
          silenceReadyRef.current = false
          silenceActiveRef.current = false
          setStatus('playing')
          setTimeout(() => {
            if (currentSongKeyRef.current === data.shazamKey) {
              silenceReadyRef.current = true
            }
          }, MIN_PLAY_TIME)
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

          setSong(data)
          setCurrentLine(0)
          setLyrics([])
          setPlainLyrics('')
          setTranslatedLyrics({})
          setShowTranslation(false)
          if (lyricsTimerRef.current) clearInterval(lyricsTimerRef.current)
          setStatus('playing')

          // Aggiunge alla cronologia
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

          await fetchLyrics(data.title, data.artist, data.album, actualOffset, responseTime)
        }

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
        const delay = consecutiveFailsRef.current >= MAX_CONSECUTIVE_FAILS
          ? FAIL_BACKOFF
          : INTERVAL_SEARCHING
        console.log(`🔍 Non trovata (tentativo ${consecutiveFailsRef.current}, prossimo tra ${delay/1000}s)`)
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
      setStatus('listening')
      recognizeTimerRef.current = setTimeout(() => {
        isRecognizingRef.current = false
        recognize(stream)
      }, INTERVAL_SEARCHING)
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
          currentSongKeyRef.current = null
          if (fallbackTimerRef.current) clearTimeout(fallbackTimerRef.current)
          if (recognizeTimerRef.current) clearTimeout(recognizeTimerRef.current)
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
    currentSongKeyRef.current = null
    previousSongKeyRef.current = null
    songFoundTimeRef.current = null
    silenceReadyRef.current = false
    silenceActiveRef.current = false
    setStatus('idle')
    setVoiceReady(false)
  }, [])

  useEffect(() => () => stopListening(), [stopListening])

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
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: textToTranslate, targetLang: 'it' })
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
  }, [translating, showTranslation, translatedLyrics, lyrics, plainLyrics, song])

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
              {/* Progress bar e durata */}
              {estimatedDuration > 0 && status === 'playing' && (
                <div className="song-progress">
                  <span className="song-time">{formatTime(elapsed)}</span>
                  <div className="progress-bar">
                    <div className="progress-fill" style={{ width: `${Math.min(100, (elapsed / estimatedDuration) * 100)}%` }} />
                  </div>
                  <span className="song-time">~{formatTime(estimatedDuration)}</span>
                </div>
              )}
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
        </div>
      </header>

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
                {translating ? '...' : 'IT'}
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
