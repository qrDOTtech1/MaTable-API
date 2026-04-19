# A table ! — API v1.0

> Backend Fastify + Socket.io + Prisma pour le SaaS de commande par QR code.

**Repo Web :** [github.com/qrDOTtech1/MaTable](https://github.com/qrDOTtech1/MaTable)  
**Production API :** [matable-api-production.up.railway.app](https://matable-api-production.up.railway.app)

---

## Stack

| Couche | Technologie |
|--------|------------|
| Framework | Fastify 5 |
| Temps réel | Socket.io 4 |
| ORM | Prisma 5 + PostgreSQL |
| Auth | JWT HS256 (Bearer header) |
| Paiement | Stripe Checkout + Webhooks |
| Déploiement | Railway (Dockerfile) |

---

## Endpoints

### Public (clients)
| Méthode | Route | Description |
|---------|-------|-------------|
| GET | `/health` | Healthcheck |
| GET | `/api/tables/:tableId` | Info table + menu |
| POST | `/api/session` | Créer/récupérer une session table |
| POST | `/api/orders` | Passer une commande (token requis) |
| GET | `/api/orders/mine` | Commandes de la session (token requis) |

### Pro (restaurateurs — Bearer token)
| Méthode | Route | Description |
|---------|-------|-------------|
| POST | `/api/pro/register` | Créer un compte + restaurant |
| POST | `/api/pro/login` | Connexion → JWT retourné |
| GET | `/api/pro/me` | Profil + restaurant |
| GET/POST | `/api/pro/tables` | Lister / ajouter une table |
| POST | `/api/pro/tables/:id/reset` | Fermer la session active |
| GET | `/api/pro/orders` | Commandes du restaurant |
| POST | `/api/pro/orders/:id/status` | Changer le statut |
| GET/POST | `/api/pro/menu` | Lister / ajouter un plat |
| PATCH/DELETE | `/api/pro/menu/:id` | Modifier / supprimer un plat |

### Stripe
| Méthode | Route | Description |
|---------|-------|-------------|
| POST | `/api/stripe/checkout` | Créer session Stripe |
| POST | `/api/stripe/webhook` | Webhook paiement confirmé |

---

## Démarrage local

```bash
git clone https://github.com/qrDOTtech1/MaTable-API.git
cd MaTable-API
npm install
cp .env.example .env   # remplir DATABASE_URL + JWT_SECRET

# PostgreSQL local (Docker)
docker run -d --name atable-pg \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=atable \
  -p 5432:5432 postgres:16

npm run db:push   # crée les tables
npm run db:seed   # insère les données démo
npm run dev       # API sur http://localhost:3001
```

Login démo : `demo@atable.fr` / `demo1234`

---

## Variables d'environnement

Voir [.env.example](.env.example)

| Variable | Requis | Description |
|----------|--------|-------------|
| `DATABASE_URL` | ✅ | URL PostgreSQL |
| `JWT_SECRET` | ✅ | Clé secrète ≥16 chars |
| `PUBLIC_WEB_URL` | ✅ | URL du service web (CORS) |
| `NODE_ENV` | ✅ | `production` ou `development` |
| `STRIPE_SECRET` | ⚡ | Clé Stripe (paiements) |
| `STRIPE_WEBHOOK_SECRET` | ⚡ | Secret webhook Stripe |

---

## Déploiement Railway

**Variables requises :**
```
DATABASE_URL          = ${{Postgres.DATABASE_URL}}
JWT_SECRET            = <clé longue aléatoire>
PUBLIC_WEB_URL        = https://matable-production-d7aa.up.railway.app
NODE_ENV              = production
```

**Au démarrage du container :**
1. `prisma db push` — synchronise le schéma
2. `prisma db seed` — insère les données démo (idempotent)
3. `node dist/server.js` — démarre l'API

---

## Architecture

```
src/
├── server.ts          ← Fastify + plugins (CORS, JWT, rate-limit)
├── auth.ts            ← Middleware Bearer token (pro + session)
├── db.ts              ← PrismaClient singleton
├── env.ts             ← Validation Zod des variables d'env
├── realtime.ts        ← Socket.io (emit par restaurant)
└── routes/
    ├── public.ts      ← Session + commandes clients
    ├── pro.ts         ← Auth + CRUD restaurateur
    └── stripe.ts      ← Checkout + webhook
prisma/
├── schema.prisma      ← Modèles DB + index
└── seed.ts            ← Données démo
```

**Modèle de session :**  
JWT signé `{ kind, sessionId, tableId, restaurantId }` — stocké côté client en localStorage.  
Invalide dès que `TableSession.active = false` (paiement ou reset manuel).

**Isolation :** Chaque requête vérifie que le `tableId` du token correspond à la ressource demandée.
