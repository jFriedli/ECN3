# ECN3

ECN3 is a Node.js calendar frontend for Bexio timesheets.

## Setup

Copy `.env.example` to `.env`, configure Bexio OAuth, then run:

```sh
npm ci
npm start
```

The server binds to `127.0.0.1:3000` by default. Set `HOST` or `PORT` only when the deployment requires a different listener.