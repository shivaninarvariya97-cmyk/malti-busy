# Busy AI Accounting App

## Run locally

```bash
npm install
npm run install:client
npm run dev
```

Frontend: `http://localhost:5173`

Backend: `http://localhost:4000`

## Production build

```bash
npm install
npm run install:client
npm run build
npm start
```

## Environment

Copy `.env.example` to `.env` and update values for production.
If you deploy the frontend separately from the backend, also copy `client/.env.example` to `client/.env` and set `VITE_API_BASE_URL`.

### JSON storage

Default mode:

```env
STORAGE_DRIVER=json
DATA_FILE=./data/store.json
```

### MongoDB storage

Optional mode:

```env
STORAGE_DRIVER=mongodb
MONGODB_URI=your-mongodb-connection-string
MONGODB_DB_NAME=busy_ai_accounting
```

If `MONGODB_URI` is present, the app can also auto-switch to MongoDB.
