# Changelog — A table ! API

Toutes les modifications notables sont documentées ici.
Format : [Keep a Changelog](https://keepachangelog.com/fr/1.0.0/)

---

## [Unreleased] — v1.1 + v1.2 (en cours)

### Ajouté — Médias & Témoignages (2026-04-20)
- **Stockage image Postgres** : modèle `Media` (bytes, mimeType, sha256, originalName). Endpoint `POST /api/pro/uploads/image` (multipart) → renvoie `{ id, path: /api/media/:id }`.
- **Témoignage vitrine** : modèle `Testimonial` (1 par restaurant), endpoints `GET /api/pro/testimonial` et `PUT /api/pro/testimonial` (upsert).
- **Schéma v1.1 complet** : ajout de `ModifierGroup`, `ModifierOption`, `DishReview`, `ServerReview`, `ServiceCall`, `StockMovement` + enums `Allergen` (14 valeurs) et `Diet` (9 valeurs).
- **Routes serveurs** : `POST /api/pro/servers`, `DELETE /api/pro/servers/:id`, `GET/PUT /api/pro/servers/:id/schedules`.
- **Route PATCH /api/pro/restaurant** : mise à jour atomique des horaires (`$transaction` delete+create).

### Ajouté — Lot A : Menu enrichi
- **Photos plats** : champ `MenuItem.imageUrl`.
- **Allergènes UE (règlement INCO 1169/2011)** : enum `Allergen` avec les 14 allergènes officiels, champ `MenuItem.allergens[]`.
- **Régimes alimentaires** : enum `Diet` (`VEGETARIAN`, `VEGAN`, `GLUTEN_FREE`, `LACTOSE_FREE`, `HALAL`, `KOSHER`, `PORK_FREE`, `LOW_CAL`, `SPICY`), champ `MenuItem.diets[]`.
- **Gestion des stocks** : `stockEnabled`, `stockQty`, `lowStockThreshold` sur `MenuItem`. Décrément transactionnel à chaque commande, auto-désactivation à 0, endpoint pro `POST /api/pro/menu/:id/restock`. Table `StockMovement` pour l'historique.
- **Disponibilité horaire** : `availableFromMin` / `availableToMin` (happy hour, plat du jour, carte du soir).
- **Modifications & variantes** : `ModifierGroup` + `ModifierOption` (cuisson, extras, sans oignons) avec `required`/`multiple`, `priceDeltaCents`. Commandes clientes enrichies.
- **Multi-langues menu** : `MenuItemTranslation` (locale + nom + description), endpoint `PUT /api/pro/menu/:id/translations`.

### Ajouté — Lot B : Expérience client
- **Avis plats** : table `DishReview` (rating 1-5 + commentaire + auteur + flag `verified`). Endpoints `POST /api/reviews/dish` (client) et `GET /api/pro/reviews/dishes`.
- **Serveurs** : table `Server` (nom, photo, actif). CRUD pro `/api/pro/servers`. Attribution de session via `POST /api/pro/tables/:id/assign-server`, héritée automatiquement par les commandes (`Order.serverId`).
- **Avis serveurs** : table `ServerReview`. Endpoints `POST /api/reviews/server`, `GET /api/r-by-table/:tableId/servers`, agrégat pro avec note moyenne + nombre d'avis par serveur.
- **Pourboires** : champs `Order.tipCents` / `TableSession.tipCents`, ligne Stripe dédiée lors du checkout, support paiement hors Stripe.
- **Appel serveur** : table `ServiceCall`, endpoint client `POST /api/service-call` + événement Socket.io `service:called`, endpoints pro `GET /api/pro/service-calls` et `POST /api/pro/service-calls/:id/resolve`.

### Ajouté — Lot C : Analytics & fiscalité
- **Analytics dashboard** : `GET /api/pro/analytics?days=N` — CA total, nombre de commandes, ticket moyen, top 10 plats, CA par jour, CA par serveur.
- **Export Z journalier** : `GET /api/pro/export/z?date=YYYY-MM-DD` — CSV téléchargeable (commandes payées, montants, mode de paiement, serveur, horodatage).

### Ajouté — Lot D : Infrastructure & conformité
- **QR sécurisé** : champ `Table.qrSecret` (préparé pour rotation HMAC v1.3).
- **Rôles utilisateurs** : enum `UserRole` (`OWNER`, `MANAGER`, `STAFF`).
- **Paramètres resto** : `PATCH /api/pro/restaurant` — description, adresse, téléphone, photos, slug public, flags `tipsEnabled`/`serviceCallEnabled`/`reviewsEnabled`.

### Ajouté — Lot E : Vitrine publique
- **Page publique `/api/r/:slug`** : détails restaurant (description, adresse, horaires), menu public, note moyenne agrégée, derniers avis vérifiés (anti-fake).
- **Slug unique par restaurant** : `Restaurant.slug` (généré à l'inscription, éditable).
- **Horaires d'ouverture** : table `OpeningHours`, endpoints `GET/PUT /api/pro/opening-hours`.

### Ajouté — Lot F : Réservations
- **Moteur de réservation** : table `Reservation` avec statuts `PENDING_PAYMENT | CONFIRMED | SEATED | HONORED | NO_SHOW | CANCELLED`.
- **Calcul de disponibilité** : `GET /api/r/:slug/availability?date=YYYY-MM-DD&partySize=N` — créneaux générés dynamiquement à partir des horaires + durée moyenne de repas, en tenant compte des réservations déjà posées.
- **Création réservation** : `POST /api/r/:slug/reservations` — création en `PENDING_PAYMENT` si arrhes requises, sinon `CONFIRMED` direct.
- **Arrhes Stripe** : `POST /api/stripe/reservation-deposit` — montant `depositPerGuestCents × partySize`, webhook dédié qui passe la réservation en `CONFIRMED` et enregistre `stripePaymentIntent`.
- **Gestion pro** : `GET /api/pro/reservations`, `POST /api/pro/reservations/:id/status` (confirm, seat, honor, no-show, cancel + assignation de table).
- **Liaison session/réservation** : `TableSession.reservationId` pour suivre la conversion.
- **Événements Socket.io** : `reservation:new`, `reservation:confirmed`, `reservation:updated`.

### Modifié
- **Stripe Checkout** : support du pourboire (ligne dédiée + agrégation des modifiers dans les libellés).
- **Webhook Stripe** : route le traitement selon `metadata.kind` (`table_bill` ou `reservation_deposit`).
- **Enregistrement restaurateur** : génère automatiquement un `slug` unique à partir du nom.
- **Seed** : restaurant démo enrichi (vitrine complète, horaires, 3 serveurs, 7 plats avec allergènes/régimes/stocks, modifiers sur le burger, arrhes 5 €/couvert).

## [Unreleased] — v1.0.x (socle billing antérieur)

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
