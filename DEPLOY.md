# LyricSync — Deploy Step-by-Step

Segui questi passi nell'ordine. Serve solo un terminale (PowerShell o CMD su Windows).

---

## PASSO 1 — Installa GitHub CLI (se non ce l'hai)

Scarica da: https://cli.github.com/
Dopo l'installazione, autenticati:

```
gh auth login
```

Scegli GitHub.com → HTTPS → Login with browser.

---

## PASSO 2 — Crea repo e pusha il BACKEND

Apri il terminale nella cartella del backend:

```
cd C:\Progetti\lyricsync-backend

git init
git branch -m main
git add .
git commit -m "Initial commit - LyricSync backend"

gh repo create lyricsync-backend --public --source=. --remote=origin --push
```

Questo crea il repo su GitHub e pusha tutto in un comando.

---

## PASSO 3 — Crea repo e pusha il FRONTEND

Apri un altro terminale nella cartella del frontend:

```
cd C:\Progetti\lyricsync-frontend

git init
git branch -m main
git add .
git commit -m "Initial commit - LyricSync frontend"

gh repo create lyricsync-frontend --public --source=. --remote=origin --push
```

---

## PASSO 4 — Deploy BACKEND su Render

1. Vai su https://dashboard.render.com/
2. Clicca **"New +"** → **"Web Service"**
3. Connetti il tuo account GitHub se non l'hai ancora fatto
4. Seleziona il repo **lyricsync-backend**
5. Configura:
   - **Name**: `lyricsync-backend`
   - **Region**: Frankfurt (EU) — il più vicino all'Italia
   - **Branch**: `main`
   - **Runtime**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
   - **Instance Type**: `Free`
6. In **Environment Variables**, aggiungi:
   - `RAPIDAPI_KEY` = `f8411f237emshcc554dd6a5138a9p109814jsnf15b5e672864`
7. Clicca **"Create Web Service"**
8. Attendi il deploy (~2-3 minuti)
9. **Prendi nota dell'URL** che Render ti assegna (es. `https://lyricsync-backend-xxxx.onrender.com`)

---

## PASSO 5 — Deploy FRONTEND su Vercel

1. Vai su https://vercel.com/dashboard
2. Clicca **"Add New..."** → **"Project"**
3. Importa il repo **lyricsync-frontend** da GitHub
4. Configura:
   - **Framework Preset**: `Vite`
   - In **Environment Variables**, aggiungi:
     - `VITE_BACKEND_URL` = l'URL di Render dal passo precedente (es. `https://lyricsync-backend-xxxx.onrender.com`)
5. Clicca **"Deploy"**
6. Attendi ~1 minuto
7. L'app sarà online all'URL che Vercel ti assegna!

---

## PASSO 6 — Verifica

1. Apri l'URL Vercel nel browser
2. Premi "Inizia ad ascoltare"
3. Fai partire un vinile e verifica che riconosca la canzone

---

## Note importanti

- **Render free tier**: Il backend si "iberna" dopo 15 minuti di inattività. La prima chiamata dopo l'ibernazione può richiedere ~30 secondi. Dopo la prima, resta attivo.
- **Per aggiornare**: Ogni volta che fai `git push` su un repo, Render e Vercel rifaranno il deploy automaticamente.
- **HTTPS**: Vercel e Render usano HTTPS automaticamente, necessario per il microfono nel browser.
