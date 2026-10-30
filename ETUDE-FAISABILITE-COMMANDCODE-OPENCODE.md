# Command Code dans OpenCode — étude de faisabilité

**Sujet** : intégrer le plan **Go à 1 $/mois** de Command Code dans **OpenCode 2.2.0**, en s'appuyant sur l'architecture des providers Pi [`Sokoshy/pi-commandcode-provider`](https://github.com/Sokoshy/pi-commandcode-provider) et [`patlux/pi-commandcode-provider`](https://github.com/patlux/pi-commandcode-provider).

**Date** : 27-28 octobre 2026.  
**Périmètre** : code source réel, documentation officielle Command Code, OpenCode v2.2.0, catalogue `models.dev`.  
**Hors périmètre** : conseil juridique, test live avec la clé Go de l'utilisateur, développement du plugin.

> **Mise à jour (30/10/2026)** : le PoC `plugin.ts` implémente cette architecture et démarre le pont **dans le processus OpenCode**. Le pont séparé `proxy.mjs` reste disponible pour le débogage. Voir `README-COMMANDCODE-GO.md`.

## 0. Lecture rapide

| Question | Réponse |
|---|---|
| OpenCode peut-il parler à Command Code ? | **Oui, déjà**, pour les plans avec accès à la Provider API (GOAT, Pro, Max, Team, Provider). Le provider `commandcode` est présent dans `models.dev` ; OpenCode 2.2.0 expose 71 modèles `commandcode/*` localement. |
| Le plan Go fonctionne-t-il via l'API officielle ? | **Non.** La documentation Command Code dit explicitement que Go est le seul plan sans accès API ; une requête renvoie `403` avec `error.code = "upgrade_required"`. |
| Existe-t-il une autre voie technique ? | **Oui, techniquement** : le transport CLI `POST https://api.commandcode.ai/alpha/generate`, utilisé par les deux providers Pi. Il est non documenté, non contractuel, et suppose d'imiter le client CLI. |
| Un plugin OpenCode suffit-il ? | **Non.** Un plugin peut enregistrer un provider, des modèles et l'authentification, mais le transport est assuré par un **provider package** ou par un **proxy local**. Pour Go, il faut donc un transport custom, pas seulement un plugin. |
| Faut-il le faire ? | Pour GOAT+ : **oui, configuration seule, faisabilité élevée**. Pour Go : **non, pas en production** ; pont technique possible mais contrat et maintenance défavorables. |

**Verdict synthétique** : le blocage n'est pas OpenCode. OpenCode sait accueillir un provider custom, un package npm/`file://` ou un proxy OpenAI-compatible. Le blocage est **produit et contractuel** : le plan Go n'a pas d'accès API officiel, et le seul transport alternatif identifié est un endpoint interne de CLI, sans engagement de stabilité ni autorisation explicite pour des clients tiers.

---

## 1. Méthode et statut des preuves

### 1.1 Ce qui a été examiné

- Les deux dépôts Pi clonés localement, à leurs commits respectifs :
  - Sokoshy : `187ee37210963976dd9245d2a730584a61e7f922`, version `0.3.0-fork.1`, 23 octobre 2026.
  - patlux : `63c8e5ccea73850266c34e655d3a76039316d4aa`, version `0.7.10`, 23 octobre 2026.
- Le code source OpenCode au tag `v2.2.0` (commit `86976449c40d48f2731553a024f74552593d1764`).
- La documentation officielle Command Code : Provider API, Go, Pricing & Limits, Headless, ACP, BYOK, Terms.
- Le catalogue public `models.dev` et l'installation OpenCode locale (`opencode --version` → `2.2.0`).

### 1.2 Statut des affirmations

| Marque | Signification |
|---|---|
| **[V]** | Vérifié dans le code source, la documentation officielle ou une commande locale à la date de l'étude. |
| **[I]** | Inféré du code ou de la documentation, mais non testé en conditions réelles (notamment avec une clé Go). |
| **[N]** | Non vérifié, incertain, ou dépendant d'une interprétation contractuelle. |

**Limite importante [N]** : aucun appel de complétion n'a été effectué avec la clé Command Code stockée localement. Le comportement `403 upgrade_required` du plan Go est établi par la documentation officielle et par le code des deux providers Pi, pas par un test live refait pour cette étude. Cette précaution évite de consommer le crédit de l'utilisateur et de manipuler sa clé.

---

## 2. L'offre Command Code et sa surface contractuelle

### 2.1 Les plans

| Plan | Prix | Accès Provider API | Remarque |
|---|---:|---|---|
| **Go** | **1 $/mois** | **Non** | Le seul plan sans accès API. Crédits : 10 $/mois, avec fenêtres de 3 $/5 h et 6 $/7 j. |
| **GOAT** | 10 $/mois | **Oui** | Jusqu'à 100 $ de crédits, accès API complet. |
| Pro / Max / Team | supérieur | Oui | Accès API. |
| Provider | pay-as-you-go | Oui | Tier API pur, sans limites de fenêtre. |

Sources : page officielle Go (`https://commandcode.ai/docs/plans/go`) et page Pricing (`https://commandcode.ai/pricing`).

La documentation officielle est sans ambiguïté :

> « **Go is the only plan without API access** — every other plan can call the Provider API with the same key it uses for the CLI. »  
> — *Go Plan*, Command Code Docs.

> « **Every plan except the Go plan has API access** — GOAT, Pro, Max, Team, and Provider all use these endpoints. »  
> — *Provider API*, Command Code Docs.

Et le corps d'erreur documenté :

> `upgrade_required`  
> « You're on the Go plan, the only plan without API access. Upgrade to GOAT or higher. »

**Conséquence [V]** : pour Go, il n'existe pas d'endpoint public de type « model provider ». Le plan Go est vendu pour le CLI, pas pour l'API.

### 2.2 La Provider API officielle

Pour les plans autorisés, Command Code expose trois compatibilités sur la même base :

- `https://api.commandcode.ai/provider/v1`
- `POST /chat/completions` — OpenAI Chat Completions.
- `POST /responses` — OpenAI Responses.
- `POST /messages` — Anthropic Messages.
- `GET /models` — catalogue de modèles.
- `POST /systemone` — endpoint spécialisé « decision model », hors sujet ici.

La documentation l'autorise explicitement pour les clients tiers :

> « Yes. The provider api has OpenAI Chat Completions, OpenAI Responses, and Anthropic compatible endpoints, **any client or agent can use them**. No lock-in. »

C'est la base de l'intégration OpenCode existante : `models.dev` déclare `commandcode` avec `npm: "@ai-sdk/openai-compatible"`, `api: "https://api.commandcode.ai/provider/v1"` et `env: ["CMD_API_KEY"]`.

### 2.3 Les surfaces officielles du plan Go

Go donne accès au **CLI** `cmd` et à ses surfaces officielles :

| Surface | Ce que c'est | Utilisable comme provider de modèle ? |
|---|---|---|
| `cmd` interactif | Agent CLI complet. | Non. |
| `cmd -p` / headless | Exécution non interactive, sortie **NDJSON** : des frames `event` puis une ligne `result`. | Non : c'est un agent, pas une API de modèle. |
| `cmd acp` | Serveur **Agent Client Protocol**, pour un client ACP (Zed, etc.). | Non : OpenCode est un serveur ACP, pas un client ACP. |
| BYOK | Ajouter un provider externe **dans** le CLI Command Code. | Non : c'est le sens inverse. |

Le mode headless est le plus proche d'une intégration programmable :

```json
{"type":"event","event":{"type":"tool_running","toolCallId":"…","toolName":"read_file","description":"…"}}
{"type":"result","subtype":"success","sessionId":"…","stopReason":"end_turn","usage":{},"durationMs":8421,"finalText":"…"}
```

Mais cette sortie est une suite d'événements d'**agent** (outils, transitions, résultat final), pas un flux de tokens d'un modèle avec injection des outils de l'appelant. Un pont OpenCode pourrait parser ces lignes, mais il ne pourrait pas exposer les outils OpenCode au modèle : le CLI garde son propre harnais, ses permissions et ses outils. Ce n'est donc pas un provider au sens OpenCode.

### 2.4 Ce que disent les Terms

Les Terms of Service Command Code contiennent notamment :

- Interdiction de **reverse engineer, decompile, disassemble, or attempt to discover the source code of the Services**.
- Interdiction de **sublicense, resell, rent, lease, transfer, or assign the services** à un tiers.
- Interdiction d'utiliser le service en **time sharing ou service bureau** pour un tiers.
- Suspension possible en cas de breach, sans remboursement.
- Les outils automatisés ne doivent pas servir à des **recherches ou requêtes automatisées** ou à extraire des données du **site web** (clause visant le site, pas nécessairement l'API).

**Ce qui n'est pas dit [N]** : aucun article des Terms consultés n'autorise explicitement un client tiers à utiliser `/alpha/generate`. Aucun article ne l'interdit nommément non plus. Le point décisif est ailleurs : le plan Go est explicitement **sans accès API**. Utiliser un endpoint interne du CLI depuis OpenCode revient à contourner cette limitation de plan, même si la clé est valide et que les crédits sont consommés.

**Conclusion contractuelle [I]** : le risque est **élevé**, pas certain. Il ne s'agit pas d'un simple avis technique : la distribution d'un plugin qui contourne une restriction de plan peut exposer à une suspension de compte et à une demande de retrait. Une interprétation juridique formelle serait nécessaire avant toute distribution.

---

## 3. Architecture des deux providers Pi

### 3.1 Vue commune

Les deux dépôts sont des **extensions Pi**, pas des plugins OpenCode. Ils suivent le même schéma :

```text
Pi (host)
  └── extension registerProvider("commandcode")
        ├── authentification (OAuth navigateur ou clé API)
        ├── catalogue de modèles (/provider/v1/models + cache)
        ├── transport "provider" (API officielle OpenAI/Anthropic)
        └── transport "generate" (CLI /alpha/generate) ← fallback Go
```

Le routeur est le même dans les deux dépôts :

1. Tentative sur la **Provider API**.
2. Si la réponse est `403` **et** que le JSON contient `error.code === "upgrade_required"`, bascule sur `/alpha/generate`.
3. Mémorisation du transport choisi **par clé API** ; un changement de clé réinitialise.
4. Tout autre `403` (permission refusée, etc.) ne déclenche **pas** le fallback.

Références :

- Sokoshy : `src/go-router.ts:13-18`, `src/go-router.ts:72-83`, `src/go-router.ts:106-183`.
- patlux : `src/transport.ts:29-40`, `src/transport.ts:65-115`.

Cette conception est pragmatique mais fragile : elle dépend d'un **code d'erreur précis** et d'un **endpoint non documenté**. Si Command Code change le code (`402`, `429`, autre message) ou renvoie un `403` différemment, le fallback casse.

### 3.2 Sokoshy : le fork qui assume le Go

- Dépôt : `Sokoshy/pi-commandcode-provider`, version `0.3.0-fork.1`.
- Fork d'un provider communautaire, avec un fallback Go ajouté.
- Transport Go porté depuis patlux v0.7.1, avec notices Apache 2.0 / MIT.
- Non publié sur npm ; installation par Git.
- README : « Adds a Go-plan fallback transport so the $1 Go plan works too. »

Fichiers clés :

| Fichier | Rôle |
|---|---|
| `index.ts` | Enregistrement du provider, mapping des modèles, routage. |
| `src/go-router.ts` | Détection du `403 upgrade_required`, mémoïsation du transport. |
| `src/go-generate.ts` | Client `/alpha/generate`, streaming, outils, raisonnement, usage, retries. |
| `src/go-converters.ts` | Conversion transcript Pi ↔ messages/tools Command Code. |
| `src/go-json-schema.ts` | Schémas d'outils, cas Gemini. |
| `src/go-overflow.ts` | Gestion des dépassements de contexte. |
| `src/responses-stream.ts` | Normalisation des deltas de raisonnement de la Provider API. |

Détails notables :

- **Version CLI codée en dur** : `COMMAND_CODE_CLI_VERSION = "1.56.0"` (`src/go-generate.ts:62-65`).
- **En-têtes** : `Authorization`, `x-command-code-version`, `x-cli-environment: production`, `x-project-slug`, `x-taste-learning: true`, `User-Agent: cli`, `x-session-id` optionnel (`src/go-generate.ts:613-623`).
- **Corps** : `{ config, memory: null, taste: null, skills: null, params, threadId }` (`src/go-generate.ts:562-588`).
- **Images** : autorisées seulement si le modèle déclare `image` ; sinon rejet côté client (`src/go-generate.ts:558-560`). Le transport sait envoyer des data URLs.
- **Raisonnement** : `reasoning-start`, `reasoning-delta`, `reasoning-end` dans le flux ; `reasoning_effort` transmis tel quel (`src/go-generate.ts:380-414`, `src/go-generate.ts:555`).
- **Outils** : `tool-input-start`, `tool-input-delta`, `tool-input-end`, `tool-call` ; arguments JSON reconstruits par accumulation (`src/go-generate.ts:420-500`).
- **Limite d'ID d'outil** : les IDs > 64 caractères sont hachés/tronqués de façon déterministe, car le backend rejette `input[N].call_id` au-delà de 64 caractères (`src/go-converters.ts:223-297`).
- **Rôle `developer`** : dégradé en `user`, car `/alpha/generate` n'accepte que `user`, `assistant`, `tool` (`src/go-converters.ts:334-343`).
- **Résultats d'outil manquants** : un résultat synthétique d'erreur est injecté pour préserver l'appairage (`src/go-converters.ts:344-380`).
- **Retries** : 429/5xx avec `Retry-After`, configurables ; valeur par défaut `0` dans le fork, et jamais de retry après émission de contenu visible (`src/go-generate.ts:70-100`, `src/go-generate.ts:627-790`).

### 3.3 patlux : l'implémentation communautaire de référence, plus complète

- Dépôt : `patlux/pi-commandcode-provider`, version `0.7.10`.
- Provider communautaire « upstream », avec le même routeur et le même transport generate.
- README d'introduction : « You need your own Command Code account, API key, and a plan with Provider API access. »
- **Incohérence documentaire** : le code et les tests live couvrent pourtant le profil Go (`test:e2e:live:go`), et le README décrit plus loin « the existing Command Code generate transport sends the matching `reasoning_effort` for Go accounts ». Le README d'intro est donc plus restrictif que le code.
- Le code reste la référence technique ; le README n'est pas une autorisation contractuelle.

Fichiers clés :

| Fichier | Rôle |
|---|---|
| `src/transport.ts` | Routeur provider/generate. |
| `src/core.ts` | Implémentation du transport generate (constante de version CLI dans `commandcode-catalog.ts`). |
| `src/converters.ts` | Conversion messages/outils, limite 64 caractères. |
| `src/responses-stream.ts` | Normalisation `response.reasoning.delta` → `response.reasoning_text.delta`. |
| `src/models.ts` | Découverte `/provider/v1/models`, sélection du wire par modèle. |
| `src/oauth.ts` | Login navigateur via Studio + callback local, ou collage de clé ; validation `/alpha/whoami`. |
| `src/runtime.ts` | Cycle de vie du provider, cache catalogue, refresh. |
| `src/quota.ts` | Endpoints internes `/alpha/whoami`, `/alpha/billing/credits`, `/alpha/billing/subscriptions`, `/alpha/usage/summary`. |
| `src/cost.ts` | Coût local, tarifs DeepSeek peak/off-peak. |
| `tests/test-live-e2e.mjs` | Tests live Go/GOAT/Provider : transport, raisonnement multi-tour, abort, outils, images. |

Détails supplémentaires :

- **Découverte des modèles** : `GET /provider/v1/models`, avec cache et fallback cache. Le choix du wire dépend du modèle et des endpoints annoncés : Claude → `/messages`, certains modèles → `/responses`, le reste → `/chat/completions` (`src/models.ts:150-165`).
- **OAuth** : le navigateur ouvre `https://commandcode.ai/studio/auth/cli?callback=...&state=...` ; le Studio renvoie la clé API au callback local. En cas d'échec, collage manuel. Validation via `/alpha/whoami`.
- **Tests live** : le profil Go doit sélectionner `generate` et rejeter les images non supportées ; le profil GOAT doit sélectionner `provider` et réussir une requête vision. C'est la preuve technique la plus forte disponible dans les dépôts.
- **Version CLI** : `1.88.0` (`src/commandcode-catalog.ts:1`), contre `1.56.0` dans le fork Sokoshy. Cet écart illustre la dépendance à la version du CLI.

**Comparaison rapide**

| Critère | Sokoshy | patlux |
|---|---|---|
| Version | `0.3.0-fork.1` | `0.7.10` |
| Positionnement | Fork communautaire, Go assumé | Provider communautaire de référence |
| Fallback Go | Oui, ajouté | Oui, dans le code |
| Version CLI | `1.56.0` | `1.88.0` |
| Catalogue | `/provider/v1/models`, pas de catalogue statique | `/provider/v1/models` + cache + snapshot de capacités |
| Auth | Clé API (README) | OAuth navigateur/paste + `/alpha/whoami` |
| Quota | Non détaillé ici | Endpoints `/alpha/billing/*`, `/alpha/usage/summary` |
| Tests live | Non détaillés ici | Profils Go/GOAT/Provider explicites |
| Distribution | Git uniquement | npm |
| Documentation | Revendique Go | Intro dit « Provider API access », code/tests couvrent Go |

### 3.4 Le protocole `/alpha/generate` en une page

```http
POST https://api.commandcode.ai/alpha/generate
Authorization: Bearer <clé>
Content-Type: application/json
x-command-code-version: 1.88.0
x-cli-environment: production
x-project-slug: <slug du répertoire>
x-taste-learning: true
User-Agent: cli
x-session-id: <uuid, optionnel>
```

```json
{
  "config": {
    "workingDir": "/projet",
    "date": "2026-10-27",
    "environment": "linux-x64, Node.js v…",
    "structure": [],
    "isGitRepo": false,
    "currentBranch": "",
    "mainBranch": "",
    "gitStatus": "",
    "recentCommits": []
  },
  "memory": null,
  "taste": null,
  "skills": null,
  "params": {
    "model": "deepseek/deepseek-v4.1-flash",
    "messages": [],
    "tools": [],
    "system": "...",
    "max_tokens": 32000,
    "stream": true,
    "temperature": 0.7,
    "reasoning_effort": "high"
  },
  "threadId": "uuid"
}
```

Le flux de réponse n'est pas du SSE standard : ce sont des **lignes JSON** (parfois préfixées `data:`) avec des événements propres :

- `text-delta` → texte assistant.
- `reasoning-start` / `reasoning-delta` / `reasoning-end` → raisonnement.
- `tool-input-start` / `tool-input-delta` / `tool-input-end` → arguments d'outil en cours.
- `tool-call` → appel d'outil complet.
- `finish` → raison d'arrêt, usage, coût.

Les deux implémentations parsent ce flux et le traduisent vers le modèle d'événements de Pi (`AssistantMessageEventStream`), qui est **spécifique à Pi**. C'est le principal point de réécriture pour OpenCode.

### 3.5 Ce que ces dépôts prouvent — et ce qu'ils ne prouvent pas

**Prouvé [V]** :

- Le transport `/alpha/generate` fonctionne avec des clés Go, dans Pi, pour du texte, des outils, du raisonnement multi-tour et l'abandon.
- Le routeur 403 → generate est opérationnel.
- Le catalogue `/provider/v1/models` est utilisé pour découvrir les modèles.
- Les tests live couvrent Go et GOAT.
- Les images sont gérées selon la capacité déclarée du modèle, avec rejet côté client sinon.

**Non prouvé [N]** :

- Que l'usage de `/alpha/generate` par un client tiers soit autorisé par Command Code.
- Que l'endpoint restera stable, ou que la version `1.56.0` / `1.88.0` restera acceptée.
- Que le catalogue `/provider/v1/models` restera accessible aux clés Go (le code le suppose ; pas de test live refait ici).
- Que les modèles listés soient tous inclus dans le plan Go (certains modèles premium sont réservés à GOAT+).
- Qu'OpenCode pourra réutiliser directement le code Pi : les types d'événements et l'API hôte sont différents.

---

## 4. OpenCode 2.2.0 : ce qui est possible

### 4.1 Le provider `commandcode` existe déjà

OpenCode importe son catalogue depuis `models.dev`. À la date de l'étude :

| Élément | Valeur |
|---|---|
| Entrée `models.dev` | `commandcode` |
| Package déclaré | `@ai-sdk/openai-compatible` |
| API | `https://api.commandcode.ai/provider/v1` |
| Variable d'environnement | `CMD_API_KEY` |
| Modèles dans `models.dev` | 72 |
| Modèles visibles localement via `opencode models` | 71 |
| Overrides Claude | `provider.npm: "@ai-sdk/anthropic"` pour les modèles Claude |

Commandes vérifiées :

```bash
opencode --version          # 2.2.0
opencode models | grep -c '^commandcode/'   # 71
opencode auth list          # CommandCode ... stored
```

**Attention au vocabulaire** : « provider `commandcode` dans OpenCode » ne signifie pas « intégration officielle Command Code ». C'est une entrée de catalogue `models.dev` qui consomme la Provider API publique ; aucun partenariat ou support officiel Command Code n'est documenté.

**Point clé** : voir les modèles dans `opencode models` ne signifie pas qu'ils sont utilisables avec Go. Le catalogue est indépendant de l'**entitlement** du plan. Avec une clé Go, l'appel Provider API renverra `403 upgrade_required`.

Pour GOAT+, l'intégration est donc **déjà faite** : il suffit d'une clé API et de sélectionner un modèle `commandcode/*`. Aucun plugin n'est nécessaire.

### 4.2 L'API plugin

OpenCode 2.2 expose notamment :

- `ctx.provider.transform(editor => …)` : ajouter/modifier/supprimer des providers, leurs settings, headers, body, modèles.
- `ctx.model.transform(editor => …)` : modifier les modèles, capacités, coûts, limites, variantes.
- `ctx.integration.connect.key(...)`, `ctx.integration.oauth.connect(...)`, `ctx.integration.command.connect(...)` : gérer l'authentification.
- `ctx.provider.reload()`, `ctx.model.reload()` : recharger après un changement externe.

Exemple minimal de transformation :

```ts
await ctx.provider.transform((editor) => {
  const provider = editor.get("commandcode")
  if (!provider) return
  provider.provider.headers = {
    ...provider.provider.headers,
    "x-example": "value",
  }
})
```

Références : `packages/plugin/src/promise/provider.ts`, `services/www/src/docs/content/build/plugins/server.mdx:101-183`.

**Ce que cela permet** : filtrer les modèles selon le plan, ajouter des en-têtes, ajuster les capacités, enregistrer une intégration d'auth, exposer un catalogue maison.

**Ce que cela ne permet pas** : changer le **transport** d'un provider existant. Un plugin ne peut pas transformer `@ai-sdk/openai-compatible` en client `/alpha/generate`. Il peut en revanche déclarer un provider dont le `package` est un package custom, ou dont le `baseURL` pointe vers un proxy.

### 4.3 Les packages provider

Le champ `package` d'un provider sélectionne le runtime qui parle au provider. La documentation OpenCode liste :

- des packages natifs : `@opencode/ai/providers/openai-compatible`, `.../anthropic`, `.../google`, etc. ;
- des packages npm arbitraires : `@acme/opencode-provider` ;
- des packages locaux : `file:///chemin/vers/package` ;
- le préfixe `aisdk:` pour charger un package AI SDK compatible (compatibilité).

Un package doit exposer :

```ts
export const model: ProviderPackage.Definition["model"] = (modelID, settings) => {
  // retourne un LanguageModel OpenCode
}
```

Références : `packages/ai/src/provider-package.ts:14-20`, `packages/core/src/provider.ts:190-213`, `services/www/src/docs/content/providers.mdx:207-267`.

**Limite importante [N]** : la documentation utilisateur explique comment **charger** un package npm ou `file://`, mais pas comment **écrire** un package provider. L'interface `LanguageModel` appartient à `@opencode/ai` et peut évoluer avec OpenCode. Un package custom est donc un point d'intégration **non documenté comme API publique stable**.

**Versionnage** : cette étude cible OpenCode **2.2.0**. Les interfaces plugin/provider ont évolué entre la v1 et la v2 (packages natifs, transforms, préfixe `aisdk:` de compatibilité). Un plugin ou un package écrit pour une autre version doit être revalidé avant usage.

### 4.4 Les trois voies d'intégration dans OpenCode

| Voie | Ce qu'on écrit | Couplage | Pertinent pour Go ? |
|---|---|---|---|
| **Configuration seule** | Aucun code ; `CMD_API_KEY` + modèles `commandcode/*`. | Faible. | Non : Go renvoie 403. |
| **Proxy local OpenAI-compatible** | Un petit serveur HTTP qui traduit OpenAI Chat Completions ↔ `/alpha/generate`. | Moyen : dépend du protocole interne, mais OpenCode ne voit qu'OpenAI. | **Oui, la voie la moins intrusive.** |
| **Package provider custom** | Un package npm/`file://` qui implémente `LanguageModel` et parle directement à `/alpha/generate`. | Fort : API interne OpenCode + protocole interne Command Code. | Oui, mais plus risqué et plus lourd. |

### 4.5 Correspondance Pi → OpenCode

| Concept Pi | Équivalent OpenCode | Réutilisation |
|---|---|---|
| `registerProvider` | `ctx.provider.transform` + `package` | Réécriture de l'enregistrement, logique de catalogue réutilisable. |
| `AssistantMessageEventStream` | `LanguageModel` / événements OpenCode | Réécriture nécessaire. |
| `Model<Api>` (input, cost, compat) | `Model.Info` (capabilities, cost, limit, package) | Adaptation des métadonnées. |
| Auth Pi (`~/.pi/agent/auth.json`) | Intégrations OpenCode (`ctx.integration`) ou `CMD_API_KEY` | Réécriture de la persistance ; ne pas lire le fichier Pi. |
| Transport provider | `@opencode/ai/providers/openai-compatible` | Réutilisation directe pour GOAT+. |
| Transport generate | Proxy ou package custom | Adaptation du protocole, pas du host. |
| `/commandcode-status`, `/commandcode-quota` | Commandes plugin ou outil | Réécriture UI. |
| Coût local (DeepSeek peak) | `cost` des modèles + éventuel plugin | Adaptation. |

### 4.6 Ce qu'OpenCode ne sait pas faire nativement

- **Pas de fallback Go** : le provider `commandcode` est un simple client OpenAI-compatible ; il ne connaît pas `/alpha/generate`.
- **Pas de client ACP** : `opencode acp` fait d'OpenCode un **serveur** ACP pour Zed et autres. Il ne consomme pas `cmd acp`.
- **Pas de transport arbitraire par plugin seul** : il faut un package provider ou un proxy.
- **Pas de découverte automatique par défaut** : les modèles d'un provider custom sont déclarés dans la config, ou ajoutés par un package/plugin.

---

## 5. Les trois scénarios

### 5.1 Scénario A — APIs publiques/officielles uniquement

#### A1. GOAT+ via la Provider API dans OpenCode

**Prérequis**

- Un plan GOAT, Pro, Max, Team ou Provider.
- Une clé API Command Code.
- `CMD_API_KEY` dans l'environnement, ou `opencode auth login` avec le provider `commandcode`.

**Mise en œuvre**

```bash
export CMD_API_KEY="..."
opencode
# puis sélectionner un modèle commandcode/*
```

Aucun plugin, aucun proxy, aucun code.

**Limites**

- Le plan Go n'est pas couvert.
- Le catalogue `models.dev` peut avoir un décalage d'un modèle (71 vs 72) ou des capacités/coûts imprécis.
- Les modèles Claude passent par le protocole Anthropic, les autres par OpenAI-compatible : OpenCode le gère déjà via les overrides `models.dev`.

**Maintenabilité** : élevée (maintenance faible). Le catalogue est mis à jour par `models.dev` ; OpenCode suit.

**Compatibilité technique** : élevée. C'est le chemin officiel, déjà présent dans OpenCode 2.2.0.

**Restrictions contractuelles** : aucune restriction spécifique ; la Provider API est explicitement ouverte aux clients tiers pour les plans autorisés.

**Verdict** : **faisabilité élevée — recommandé.**

#### A2. Go via la Provider API officielle

**Prérequis** : une clé Go.

**Réalité** : la Provider API renvoie `403 upgrade_required`. Il n'existe aucun endpoint public de modèle pour Go. Le CLI, headless et ACP sont les seules surfaces officielles.

**Limites** : aucun contournement officiel. Le fait que `opencode models` liste les modèles ne change rien à l'entitlement.

**Maintenance** : sans objet.

**Compatibilité technique** : nulle via l'API officielle.

**Restrictions contractuelles** : le plan Go exclut explicitement l'accès API ; forcer un autre endpoint n'est plus « API officielle ».

**Verdict** : **non démontrée — bloquée par un 403 documenté.** Ce n'est pas une limite d'OpenCode, c'est une limite de produit Command Code.

#### A3. Go via le CLI officiel (headless ou ACP) comme « provider »

**Prérequis** : `cmd` installé, `cmd login` effectué, plan Go.

**Mode headless** : `cmd -p "prompt" --output-format json` produit des événements d'agent et un résultat final. On peut l'invoquer depuis un outil ou une commande OpenCode.

**Mode ACP** : `cmd acp` expose un serveur ACP. OpenCode est lui-même un serveur ACP, pas un client ; il ne peut donc pas s'y connecter comme fournisseur de modèle.

**Limites**

- Ce n'est pas un provider : pas d'injection des outils OpenCode dans le modèle, pas de streaming token par token natif, pas de contrat `LanguageModel`.
- Le CLI garde son propre harnais, ses permissions, son contexte et ses outils.
- On obtient un agent imbriqué, pas une intégration de modèle.
- Le mode headless bloque par défaut les écritures/commandes ; il faut gérer les permissions.

**Maintenabilité** : moyenne ; le CLI peut évoluer, mais le contrat headless est documenté.

**Compatibilité technique** : faible en tant que provider ; élevée en tant qu'outil séparé.

**Restrictions contractuelles** : officiel, donc faible risque.

**Verdict** : **faible comme provider ; acceptable comme outil de délégation ou usage côte à côte.** Ce n'est pas la solution demandée.

### 5.2 Scénario B — mécanismes alternatifs utilisés par le client officiel / la communauté

C'est le scénario des deux providers Pi : utiliser `/alpha/generate`, l'endpoint du CLI, avec les en-têtes et le corps du CLI.

#### B1. Proxy local OpenAI-compatible (recommandé pour l'expérimentation)

**Architecture**

```text
OpenCode
  └── provider "commandcode-go"
        └── @opencode/ai/providers/openai-compatible
              └── http://127.0.0.1:8787/v1/chat/completions
                    └── bridge local (Node/Bun)
                          └── POST https://api.commandcode.ai/alpha/generate
```

**Pourquoi un proxy plutôt qu'un package provider ?**

- OpenCode ne voit qu'un endpoint OpenAI Chat Completions, contrat public et stable.
- On réutilise le package natif `openai-compatible` ; pas de dépendance à `@opencode/ai` interne.
- Le bridge est testable avec `curl`, un SDK OpenAI, ou n'importe quel client.
- On peut le remplacer par un vrai provider plus tard sans toucher à OpenCode.
- En cas de changement de protocole, on modifie un seul process.

**Prérequis**

- Une clé Go valide.
- Un runtime Node/Bun.
- Un port localhost (ex. 8787), idéalement protégé par un token local.
- Les modèles Go déclarés dans la config OpenCode (au moins un modèle texte/outils).

**Ce que le bridge doit implémenter**

| Fonction | Détail |
|---|---|
| `GET /v1/models` | Liste statique ou dérivée de `/provider/v1/models` / `models.dev`. |
| `POST /v1/chat/completions` | Traduction OpenAI → `/alpha/generate`. |
| SSE OpenAI | `data: {...}` avec `choices[].delta.content`, `reasoning_content`, `tool_calls`, `finish_reason`, `usage`. |
| Outils | Conversion `tools` OpenAI → `{type:"function", name, description, input_schema}` ; conversion inverse des `tool_calls`. |
| Transcript | `system` → `params.system` ; `developer` → `user` ; `tool` → `{role:"tool", content:[{type:"tool-result",...}]}`. |
| IDs d'outil | Hachage/troncature déterministe ≤ 64 caractères, cohérent entre appels et résultats. |
| Contexte | Extraction du system prompt, gestion des messages système multiples. |
| Session | `threadId` UUID stable par session OpenCode (ou UUID généré). |
| Raisonnement | `reasoning_effort` selon le modèle ; deltas `reasoning_content`. |
| Images | Data URLs si le modèle les supporte ; sinon erreur claire côté bridge. |
| Abandon | Propagation de l'abort OpenCode vers `fetch`. |
| Retries | 429/5xx avec `Retry-After`, pas de retry après contenu visible. |
| Erreurs | Mapping `403 upgrade_required`, `401`, `429`, `5xx` vers des erreurs OpenAI lisibles. |
| Sécurité | Ne jamais logger la clé ; token local ; pas de télémétrie. |

**Configuration OpenCode (exemple)**

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "providers": {
    "commandcode-go": {
      "name": "Command Code Go (unofficial)",
      "env": ["COMMANDCODE_GO_BRIDGE_TOKEN"],
      "package": "@opencode/ai/providers/openai-compatible",
      "settings": {
        "baseURL": "http://127.0.0.1:8787/v1"
      },
      "models": {
        "deepseek-v4.1-flash": {
          "name": "DeepSeek V4.1 Flash (Go)",
          "capabilities": {
            "tools": true,
            "input": ["text"], // conservateur : images selon entitlements Go
            "output": ["text"]
          },
          "limit": { "context": 1000000, "output": 384000 }
        }
      }
    }
  }
}
```

Le bridge détient la vraie clé Command Code dans son propre environnement ; OpenCode n'envoie qu'un token local. C'est plus propre que de mettre la clé Command Code dans la config OpenCode.

**Variante** : réutiliser le provider `commandcode` existant en surchargeant `settings.baseURL` vers le proxy. Plus simple, mais attention aux overrides de package des modèles Claude (`@ai-sdk/anthropic`) qui pourraient court-circuiter le proxy. Pour un MVP, déclarer explicitement les modèles Go est plus sûr.

**Limites**

- Endpoint non documenté, versionné par un header CLI (`1.56.0` / `1.88.0`).
- Format de flux non standard, événements propres à Command Code.
- Contraintes empiriques : IDs d'outil ≤ 64 caractères, rôle `developer` refusé, résultats d'outil manquants à synthétiser.
- Le bridge doit suivre les évolutions du CLI ; pas de SLA.
- Les crédits Go restent consommés ; aucun contournement des limites de 3 $/5 h et 6 $/7 j.
- Certains modèles listés peuvent être réservés à GOAT+ ; le bridge doit gérer les erreurs ou filtrer.

**Maintenabilité** : faible. Un changement de CLI peut casser le bridge ; il faut un test de fumée à chaque release. Ordre de grandeur : quelques heures à quelques jours par changement majeur, sans prévisibilité.

**Compatibilité technique** : moyenne. Le protocole est connu et testé par deux implémentations, mais il n'est pas conçu pour des clients tiers.

**Restrictions contractuelles** : **risque élevé**. Le plan Go est explicitement sans accès API ; l'endpoint est interne au CLI ; les Terms interdisent le reverse engineering et le transfert d'accès. Aucune autorisation explicite n'a été trouvée.

**Verdict** : **faisabilité technique moyenne, risque contractuel élevé, maintenabilité faible. Expérimental, pas production, pas distribution.**

#### B2. Package provider custom (alternative plus intégrée)

Écrire un package `@votre-scope/opencode-provider-commandcode-go` qui exporte `model()` et parle directement à `/alpha/generate`, sans proxy.

**Avantages**

- Un seul process.
- Pas de port localhost.
- Distribution npm possible.
- Accès direct aux types OpenCode.

**Inconvénients**

- Il faut implémenter l'interface `LanguageModel` d'OpenCode, non documentée comme API d'extension stable.
- Il faut reproduire la traduction des événements, des outils et du raisonnement dans le modèle OpenCode, pas seulement en OpenAI.
- Couplage fort à la version d'OpenCode et à la version du CLI.
- Plus difficile à tester et à déboguer qu'un proxy.

**Verdict** : **faisabilité technique moyenne, risque contractuel élevé, maintenabilité faible.** À envisager seulement si le proxy devient un produit et que l'on veut une intégration native.

#### B3. Pont headless/ACP

- `cmd -p` : possible via un outil OpenCode, mais agent imbriqué, pas provider.
- `cmd acp` : impossible comme provider, car OpenCode est serveur ACP, pas client.

**Verdict** : **faible pour l'objectif « provider » ; officiel mais hors sujet.**

### 5.3 Scénario C — reproduction des internes non documentés

Il s'agirait d'aller plus loin : reproduire le comportement complet du CLI, y compris les champs `config`, `memory`, `taste`, `skills`, les endpoints de quota, la télémétrie, la détection de plan, les versions, etc.

**Ce que cela demanderait**

- Suivre les releases du CLI et extraire les nouveaux champs/headers.
- Reproduire les endpoints `/alpha/whoami`, `/alpha/billing/*`, `/alpha/usage/summary`.
- Gérer les sessions/threads, le cache, les préférences (`taste`), les skills.
- Imiter les versions et environnements du CLI.
- Maintenir des tests de non-régression sur un protocole mouvant.

**Risques**

- **Technique** : casse à chaque release, comportements non observables, pas de spécification.
- **Contractuel** : reverse engineering, contournement de plan, transfert d'accès ; risque de suspension.
- **Sécurité** : manipulation de clés, de quotas et de données de compte ; surface d'attaque plus large.
- **Éthique/produit** : un client tiers qui se fait passer pour le CLI officiel peut tromper le fournisseur et les utilisateurs.

**Verdict** : **faisabilité technique faible, risque contractuel élevé, maintenabilité faible. À ne pas faire.** Le gain par rapport au proxy est marginal ; le risque est bien plus élevé.

### 5.4 Synthèse des scénarios

| Scénario | Technique | Risque contractuel | Maintenabilité | Verdict |
|---|---|---|---|---|
| **GOAT+ via Provider API dans OpenCode** | Élevée | Faible (autorisé) | Élevée | **Élevée — recommandé** |
| **Go via Provider API officielle** | Non démontrée (403) | N/A | N/A | **Non démontrée — impossible aujourd'hui** |
| **Go via proxy `/alpha/generate`** | Moyenne | Élevé | Faible | **Moyenne technique / faible contractuelle — expérimental** |
| **Go via package provider custom** | Moyenne (couplage fort) | Élevé | Faible | **Faible — seulement si produit** |
| **Go via CLI headless/ACP** | Faible comme provider | Faible (officiel) | Moyenne | **Faible comme provider ; acceptable comme outil séparé** |
| **Reproduction complète des internes** | Faible | Élevé | Faible | **Non recommandé** |

---

## 6. Architecture recommandée

### 6.1 Décision

```text
Le besoin est-il « utiliser Command Code dans OpenCode » ?
├── Oui, et le budget permet GOAT+ (10 $/mois)
│     └── Configuration seule : provider commandcode + CMD_API_KEY. FIN.
├── Oui, et le budget est strictement Go (1 $/mois)
│     ├── Option officielle : garder cmd à côté d'OpenCode.
│     │     └── Pas d'intégration provider ; éventuellement un outil de délégation.
│     └── Option expérimentale : proxy local /alpha/generate.
│           └── Usage personnel, non distribué, avec garde-fous.
└── Non : ne rien construire.
```

### 6.2 Recommandation principale : GOAT+ et configuration seule

C'est la seule voie qui soit à la fois **officielle**, **stable** et **sans code**. OpenCode 2.2.0 sait déjà faire :

1. Lire `CMD_API_KEY`.
2. Charger les modèles `commandcode/*` depuis `models.dev`.
3. Router Claude vers Anthropic et les autres vers OpenAI-compatible.
4. Afficher les coûts/limites du catalogue.

Le coût passe de 1 $ à 10 $/mois, mais GOAT inclut jusqu'à 100 $ de crédits et l'accès API complet. Si l'objectif est de travailler dans OpenCode, c'est le meilleur rapport risque/effort. Le plan Provider pay-as-you-go donne aussi l'accès API, mais sans crédits inclus ; pour un usage OpenCode régulier, GOAT est généralement plus simple.

### 6.3 Recommandation de secours : `cmd` à côté d'OpenCode

Si le budget Go est non négociable :

- Utiliser `cmd` dans un terminal séparé pour les tâches Command Code.
- Ou écrire une **commande OpenCode** qui appelle `cmd -p` et affiche le résultat.
- Ne pas présenter cela comme un provider : c'est un agent imbriqué.
- Avantages : officiel, pas de reverse engineering, pas de clé exposée à un proxy.
- Inconvénients : pas de continuité de contexte native, pas d'outils OpenCode injectés, pas de streaming token par token, duplication des permissions.

C'est la seule option « propre » pour Go.

### 6.4 Si vous expérimentez le proxy : garde-fous

1. **Usage personnel uniquement** ; ne pas publier sur npm, ne pas distribuer de binaire.
2. **Clé dans l'environnement du bridge**, jamais dans la config OpenCode, jamais dans les logs.
3. **Token local** entre OpenCode et le bridge ; bind sur `127.0.0.1`, pas `0.0.0.0`.
4. **Aucune télémétrie**, aucun stockage de prompts.
5. **Test de fumée** à chaque release Command Code : un prompt texte, un appel d'outil, un raisonnement, un abort.
6. **Message clair** dans l'UI : « unofficial, may break, Go plan only ».
7. **Kill switch** : variable d'environnement pour désactiver le bridge.
8. **Ne pas imiter une version CLI que vous n'utilisez pas** ; utiliser la version réellement installée.
9. **Ne pas contourner les limites de crédits** ; le bridge consomme le compte normal.
10. **Ne pas promettre** que les modèles premium sont inclus dans Go ; filtrer ou laisser l'erreur remonter.

**Stratégie de tests**

| Niveau | Contenu |
|---|---|
| Unitaire | Conversion des messages, schémas d'outils, IDs ≤ 64 caractères, parsing du flux, mapping des erreurs. |
| Contrat | Rejouer des fixtures de flux `/alpha/generate` (texte, raisonnement, outil, finish, erreur) sans réseau. |
| Intégration | Un faux serveur `/alpha/generate` ; vérifier le contrat OpenAI côté client (streaming, tool calls, usage). |
| Smoke live | Manuel, avec une clé Go : texte, outil, raisonnement multi-tour, abort, image refusée. |
| Canary | Vérifier la version CLI et le format du flux à chaque release ; échouer avec un message clair plutôt que de produire des réponses silencieusement fausses. |
| CI | Pas de clé live dans la CI ; fixtures uniquement, plus un test de packaging. |

### 6.5 Ce qu'il ne faut pas construire

- Un plugin qui se présente comme officiel.
- Un package qui embarque la clé de l'utilisateur ou la transmet à un tiers.
- Un scraping du site ou une extraction de endpoints par ingénierie inverse du binaire.
- Un système de multi-comptes pour contourner les limites Go.
- Un provider qui prétend supporter Go via l'API officielle alors que le 403 est documenté.
- Une réimplémentation complète du CLI et de ses endpoints de quota.

---

## 7. Risques, inconnues et points à vérifier

| # | Point | Statut | Impact |
|---|---|---|---|
| 1 | Pas de test live Go refait pour cette étude. | **[N]** | Le 403 est documenté et implémenté, mais non reproduit localement. |
| 2 | Interprétation des Terms sur `/alpha/generate`. | **[N]** | Risque contractuel élevé ; pas un avis juridique. |
| 3 | Stabilité de `/alpha/generate` et du header de version. | **[N]** | Casse possible à chaque release CLI. |
| 4 | Accès des clés Go à `/provider/v1/models`. | **[I]** | Le code Pi le suppose ; non testé ici. |
| 5 | Entitlements exacts des modèles Go. | **[I]** | Certains modèles listés peuvent être réservés à GOAT+. |
| 6 | Stabilité de l'API package provider d'OpenCode. | **[N]** | L'écriture de packages n'est pas documentée comme API publique. |
| 7 | Overrides de package des modèles Claude dans un provider custom. | **[I]** | Peut court-circuiter un proxy si le catalogue est hérité. |
| 8 | Roadmap Command Code pour un accès API Go ou une intégration OpenCode. | **[N]** | Aucune information publique trouvée. |
| 9 | Prix/limites Go susceptibles d'évoluer. | **[V]** | La doc mentionne déjà un changement de facturation ; vérifier à la date d'usage. |
| 10 | Consommation des crédits par le bridge. | **[V]** | Le bridge ne contourne pas les limites ; il les consomme. |

### 7.1 Ce qui est explicitement non vérifié

- Le comportement exact d'OpenCode face à un `403 upgrade_required` du provider `commandcode` (message d'erreur, retry, fallback). On sait que le provider n'a pas de fallback Go ; on n'a pas provoqué l'erreur.
- La disponibilité de `/provider/v1/models` pour une clé Go.
- La compatibilité du bridge avec tous les modèles Go (Claude, Gemini, GPT, open models) : les schémas d'outils et le raisonnement peuvent différer.
- La possibilité de réutiliser le catalogue `models.dev` pour un provider custom avec `canonical` sans casser les overrides de package.
- La position officielle de Command Code sur un client tiers utilisant `/alpha/generate`.

---

## 8. Verdict final

### 8.1 Réponse directe

**Est-il techniquement possible de faire fonctionner le plan Go dans OpenCode ?**  
**Oui, techniquement**, via un pont qui reproduit le transport CLI `/alpha/generate`, comme le font les providers Pi. Le protocole est connu, deux implémentations existent, et OpenCode peut exposer un provider OpenAI-compatible pointant vers un proxy local.

**Est-ce possible avec les APIs publiques/officielles ?**  
**Non.** Command Code documente explicitement que Go est le seul plan sans accès API. La Provider API renvoie `403 upgrade_required`. Aucun endpoint officiel de type « model provider » n'existe pour Go.

**Est-ce autorisé ?**  
**Pas explicitement.** Les Terms n'autorisent pas explicitement les clients tiers de `/alpha/generate` ; le plan Go exclut l'accès API ; le reverse engineering est interdit. Le risque contractuel est élevé, même si la clé est valide et que les crédits sont payés.

**Est-ce maintenable ?**  
**Non, pas sans effort.** Le transport est non documenté, versionné par un header CLI, avec des contraintes empiriques (IDs d'outil ≤ 64 caractères, rôle `developer`, résultats d'outil manquants, format de flux non standard). Chaque release peut casser le pont.

**Que recommander ?**  
1. **GOAT+ (10 $/mois) + provider `commandcode` existant** : officiel, stable, zéro code. Faisabilité **élevée**.
2. **Go + `cmd` séparé** : officiel, mais pas un provider. Faisabilité **faible** pour l'objectif d'intégration native.
3. **Go + proxy expérimental** : seulement pour un usage personnel, avec garde-fous, sans distribution. Faisabilité **moyenne** techniquement, **faible** contractuellement.
4. **Reproduction complète des internes** : **non recommandée**.

### 8.2 Tableau de décision

| Objectif | Solution | Effort | Risque | Verdict |
|---|---|---|---|---|
| Utiliser Command Code dans OpenCode, proprement | GOAT+ + `CMD_API_KEY` | Nul | Faible | **Élevée** |
| Rester à 1 $/mois et utiliser OpenCode | Pont `/alpha/generate` | 10-16 jours MVP, maintenance continue | Élevé | **Moyenne technique / faible contractuelle** |
| Rester à 1 $/mois sans contournement | `cmd` à côté d'OpenCode | Faible | Faible | **Faible comme provider, acceptable comme outil** |
| Intégration officielle Go dans OpenCode | Aucune disponible | — | — | **Non démontrée** |
| Reconstruire le CLI/les internes | — | Très élevé | Très élevé | **À ne pas faire** |

### 8.3 La phrase à retenir

> **OpenCode n'est pas le blocage : le plan Go n'a pas d'API de modèle. Le seul transport alternatif identifié est un endpoint interne de CLI, non documenté et sans autorisation explicite pour des clients tiers. La voie officielle est GOAT+ ; la voie Go dans OpenCode est un contournement technique, pas une intégration supportable.**

---

## Annexe A — Preuves et commandes

### A.1 Commandes locales

```bash
opencode --version
# opencode v2.2.0

opencode models | grep -c '^commandcode/'
# 71

opencode auth list
# CommandCode       CommandCode                 stored
```

### A.2 `models.dev`

```bash
curl -s https://models.dev/api.json -o /tmp/models-dev-api.json
```

Extrait vérifié :

```json
{
  "commandcode": {
    "name": "CommandCode",
    "api": "https://api.commandcode.ai/provider/v1",
    "npm": "@ai-sdk/openai-compatible",
    "env": ["CMD_API_KEY"],
    "models": { "...": "72 entrées" }
  }
}
```

Les modèles Claude portent un override `provider.npm: "@ai-sdk/anthropic"`.

### A.3 Citations officielles Command Code

| Sujet | Citation | Source |
|---|---|---|
| Go sans API | « Go is the only plan without API access — every other plan can call the Provider API with the same key it uses for the CLI. » | `docs/plans/go` |
| Go sans API | « Every plan except the Go plan has API access — GOAT, Pro, Max, Team, and Provider all use these endpoints. » | `docs/provider-api` |
| Erreur | « `upgrade_required` — You're on the Go plan, the only plan without API access. Upgrade to GOAT or higher. » | `docs/provider-api` |
| Clients tiers | « any client or agent can use them » | `docs/provider-api` |
| Headless | NDJSON `event` / `result` | `docs/headless` |
| ACP | `cmd acp` serveur ACP | `docs/acp` |
| Terms | « Reverse engineer, decompile, disassemble, or attempt to discover the source code of the Services. » | `/terms` |

### A.4 Fichiers sources cités

**Sokoshy**

- `index.ts`
- `src/go-router.ts`
- `src/go-generate.ts`
- `src/go-converters.ts`
- `src/go-json-schema.ts`
- `src/go-overflow.ts`
- `src/responses-stream.ts`
- `README.md`

**patlux**

- `src/transport.ts`
- `src/core.ts`
- `src/converters.ts`
- `src/responses-stream.ts`
- `src/models.ts`
- `src/oauth.ts`
- `src/runtime.ts`
- `src/quota.ts`
- `src/cost.ts`
- `src/commandcode-catalog.ts`
- `tests/test-live-e2e.mjs`
- `README.md`

**OpenCode v2.2.0**

- `packages/plugin/src/promise/provider.ts`
- `packages/schema/src/provider.ts`
- `packages/schema/src/model.ts`
- `packages/core/src/provider.ts`
- `packages/ai/src/provider-package.ts`
- `packages/ai/src/providers/openai-compatible.ts`
- `packages/ai/src/protocols/openai-chat.ts`
- `services/www/src/docs/content/providers.mdx`
- `services/www/src/docs/content/build/plugins/server.mdx`
- `services/www/src/docs/content/cli/acp.mdx`

---

## Annexe B — Référence rapide du transport Go

| Élément | Valeur |
|---|---|
| Endpoint | `POST https://api.commandcode.ai/alpha/generate` |
| Auth | `Authorization: Bearer <clé>` |
| Version CLI | `x-command-code-version: 1.56.0` (fork) / `1.88.0` (patlux) |
| Environnement | `x-cli-environment: production` |
| Projet | `x-project-slug: <slug>` |
| Préférences | `x-taste-learning: true` |
| User-Agent | `cli` |
| Session | `x-session-id: <uuid>` (optionnel) |
| Corps | `{ config, memory, taste, skills, params, threadId }` |
| Streaming | lignes JSON, événements `text-delta`, `reasoning-*`, `tool-*`, `finish` |
| Fallback | uniquement `403` + `error.code === "upgrade_required"` |
| Limite outil | `call_id` ≤ 64 caractères |
| Rôles | `user`, `assistant`, `tool` uniquement (pas de `developer`) |

---

## Annexe C — Estimation d'effort

| Tâche | Effort indicatif |
|---|---|
| Proxy MVP : HTTP, `/v1/models`, `/v1/chat/completions` | 2-3 jours |
| Client `/alpha/generate` + parsing du flux | 2-3 jours |
| Traduction OpenAI (texte, raisonnement, outils, usage) | 2-3 jours |
| Conversion transcript/outils/IDs/rôles | 2-3 jours |
| Abort, retries, erreurs, sécurité locale | 1-2 jours |
| Tests unitaires + test live Go | 1-2 jours |
| **Total MVP prudent** | **10-16 jours** |
| Durcissement multi-modèles, images, coûts, UI | +1-2 semaines |
| Package provider custom à la place du proxy | +1-2 semaines, couplage OpenCode |

Ces estimations sont des ordres de grandeur, hors validation juridique et hors tests live approfondis.

---

*Étude réalisée les 27-28 octobre 2026. Les prix, plans, endpoints et catalogues peuvent changer ; vérifier la documentation officielle avant toute décision.*
