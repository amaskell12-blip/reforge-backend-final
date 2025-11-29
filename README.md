# Reforge Backend - Production Server

This is the **production backend** for the Reforge AI Fitness Coach app. It contains all proprietary business logic for workout generation, nutrition calculation, daily prompts, and AI coaching.

## 📦 Contents

- `server/index.ts` - Express.js API server with 7 endpoints
- `package.json` - Production dependencies
- `tsconfig.json` - TypeScript configuration
- `.gitignore` - Excludes node_modules and secrets

## 🚀 Quick Deploy to Render

### 1. Upload This Folder

**Option A: Manual Upload**
- Render Dashboard → New Web Service → Upload folder
- Drag/drop the entire `backend/` folder

**Option B: GitHub Deploy**
- Push this folder to your GitHub repository
- Render Dashboard → New Web Service → Connect repository
- Set **Root Directory**: `backend/` (or wherever you placed this folder)

### 2. Configure Build Settings

- **Build Command**: `npm install`
- **Start Command**: `npm start`
- **Environment**: Node.js

### 3. Add Environment Variables

**Required**:
```
OPENAI_API_KEY=sk-proj-... (your OpenAI API key)
PORT=3001 (optional, Render auto-assigns if omitted)
```

### 4. Deploy

Click "Create Web Service" and wait 3-5 minutes.

## 🔗 API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/api/chat` | POST | GPT-4o-mini streaming chat |
| `/api/system-prompt` | POST | Generate Coach Max personality |
| `/api/generate-program` | POST | Generate 30-day workout plan |
| `/api/calculate-nutrition` | POST | Calculate macros |
| `/api/daily-prompt/:day` | GET | Daily motivational prompt |
| `/api/milestone/:day` | GET | Milestone celebration message |

## 🔒 Security Features

- **CORS**: Locked to approved origins (Replit dev, Expo Go, production)
- **Rate Limiting**:
  - Chat: 30 requests/hour
  - API: 100 requests/hour
- **Token Limits**: Max 300 tokens per chat response
- **Model Hardcoded**: GPT-4o-mini only (no upgrades without server update)

## 🧪 Verify Deployment

After deploying, test these endpoints:

```bash
# 1. Health check
curl https://your-app.onrender.com/health

# 2. Calculate nutrition
curl -X POST https://your-app.onrender.com/api/calculate-nutrition \
  -H "Content-Type: application/json" \
  -d '{"onboarding":{"weight":75,"height":175,"age":30,"goal":"shred","fitnessLevel":"intermediate"}}'

# 3. Daily prompt
curl https://your-app.onrender.com/api/daily-prompt/1

# 4. Chat (requires OPENAI_API_KEY)
curl -X POST https://your-app.onrender.com/api/chat \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Hello"}],"stream":false}'
```

## 📊 Monitoring

Check Render logs for:
- `[CORS] Blocked origin:` - Invalid origin attempts
- `[RATE LIMIT]` - Users hitting rate limits
- `[Token Usage]` - OpenAI API usage and costs

## 🛠️ Local Development

```bash
# Install dependencies
npm install

# Set environment variable
export OPENAI_API_KEY=sk-proj-...

# Run development server
npm run dev

# Server starts on http://localhost:3001
```

## 📝 Notes

- All proprietary content (workout logic, nutrition formulas, prompts) is server-side only
- Frontend cannot access this code - it's protected intellectual property
- Never commit `.env` files or expose `OPENAI_API_KEY`
- Render auto-assigns `PORT` - do not hardcode it

## 🆘 Support

For deployment issues:
1. Check Render build logs
2. Verify `OPENAI_API_KEY` is set
3. Test endpoints with curl commands above
4. Check CORS settings if the frontend can't connect
