# Changelog — A table ! API

Toutes les modifications notables sont documentées ici.
Format : [Keep a Changelog](https://keepachangelog.com/fr/1.0.0/)

---

## [Unreleased]

### Modifié
- **Stripe Checkout** : paiement au niveau **TableSession** (addition) en agrégeant toutes les commandes non payées de la session.
- **Webhook Stripe** : au paiement, passe toutes les commandes de la session en `PAID` (hors `CANCELLED`) puis ferme la session.

### Ajouté
- **Addition** : endpoint client `POST /api/bill/request` (mode `CARD|CASH|COUNTER`) + événement Socket.io `bill:requested`.
- **Encaissement (pro)** : endpoint `POST /api/pro/tables/:id/settle` pour marquer les commandes de la session en `PAID` et fermer la session (paiement hors Stripe).
- **DB** : champs `billRequestedAt` / `billPaymentMode` sur `TableSession`.

## [1.0.0] — 2026-04-19

### Première version publique — MVP complet

#### Ajouté
- **Auth** : register + login, JWT Bearer HS256, pas de cookie (compatible cross-domain)
- **Session table** : token JWT par table, invalidé au paiement ou reset manuel
- **Commandes** : création, liste, changement de statut (PENDING → COOKING → SERVED → PAID)
- **Menu** : CRUD complet par restaurant, activation/désactivation par plat
- **Tables** : création auto-incrémentée, reset de session, statut occupé/libre
- **Stripe** : Checkout Session + webhook `checkout.session.completed` → fermeture automatique de session
- **Socket.io** : émission temps réel par room `restaurant:<id>` — événements `order:new` et `order:paid`
- **Rate limiting** : 120 req/min par IP via `@fastify/rate-limit`
- **CORS** : `origin: true` (toutes origines acceptées) + credentials
- **Seed** : restaurant démo + 5 tables + 5 plats + 1 utilisateur (`demo@atable.fr`)
- **Déploiement Railway** : Dockerfile node:20-slim, `prisma db push` + seed au démarrage

#### Base de données (Prisma + PostgreSQL)
- `Restaurant` — `User` — `Table` — `TableSession` — `Order` — `MenuItem`
- Index : `(restaurantId)`, `(tableId, active)`, `(status, createdAt)`, `(sessionId)`
