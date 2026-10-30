# Command Code Go dans OpenCode — provider + pont local

Ce dossier contient un PoC en deux pièces :

```text
OpenCode 2.2.x
  └── provider "commandcode-go"          (plugin.ts, catalogue copié de models.dev)
        └── @opencode/ai/providers/openai-compatible
              └── http://127.0.0.1:<port>/v1/chat/completions
                    └── pont démarré par le plugin
                          └── POST https://api.commandcode.ai/alpha/generate
```

- `plugin.ts` : ajoute le provider `commandcode-go`, copie les modèles du provider `commandcode` de `models.dev`, et démarre le pont **dans le processus OpenCode**.
- `proxy.mjs` : le pont OpenAI ↔ `/alpha/generate`. Il est importé par le plugin ; il peut aussi être lancé seul pour déboguer.
- `proxy.test.mjs` : tests des conversions et du flux, avec un faux serveur Command Code.

## Avertissement

Ce montage est **non officiel**. Le plan Go de Command Code n'inclut pas l'accès à la Provider API, `/alpha/generate` est le transport interne du CLI, et les conditions d'utilisation interdisent le reverse engineering et le transfert d'accès. Le pont ne contourne ni les quotas ni les droits du plan Go. À réserver à un usage local et expérimental ; ne pas distribuer.

## Démarrage rapide — mode automatique

Tu n'as besoin que de ta clé API Command Code (la même que celle utilisée avec Pi). Pas de `proxy.mjs` à lancer, pas de token local à gérer.

### 1. Configurer OpenCode

Dans `opencode.jsonc`, pointe vers le **dossier** du plugin :

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "/chemin/absolu/vers/commandcode",
      "options": {
        "apiKey": "{env:CMD_API_KEY}"
      }
    }
  ]
}
```

`{env:CMD_API_KEY}` évite d'écrire la clé en clair dans le fichier. Tu peux aussi mettre la clé directement dans `apiKey`, ou ne pas mettre d'option et exporter `CMD_API_KEY` / `COMMAND_CODE_API_KEY` avant de lancer OpenCode.

Le plugin importe `proxy.mjs` : pointe vers le **dossier complet**, pas seulement vers `plugin.ts`. Remplace `/chemin/absolu/vers/commandcode` par le chemin réel du dossier.

### 2. Lancer OpenCode

```bash
export CMD_API_KEY='ta-clé-API-Command-Code'
opencode --standalone
```

Le plugin démarre un pont local sur un port éphémère, génère un token local aléatoire, et configure le provider tout seul. Aucun autre processus à garder ouvert.

Vérification :

```bash
opencode --standalone models | grep '^commandcode-go/'
```

Attendu : `71` modèles avec le catalogue `models.dev` du 29/10/2026. Le nombre dépend du catalogue.

Puis choisis un modèle `commandcode-go/*` dans le TUI, ou :

```bash
opencode --standalone run \
  -m commandcode-go/claude-haiku-4-5-20251001 \
  "Réponds juste: ok"
```

Si le modèle n'est pas inclus dans le plan Go, l'erreur `403 upgrade_required` remonte dans OpenCode ; essaie un autre modèle.

### Si OpenCode tourne en service d'arrière-plan

Le service doit voir `CMD_API_KEY`. Pour tester, `opencode --standalone` est le plus simple. Sinon :

```bash
opencode service stop
export CMD_API_KEY='ta-clé-API-Command-Code'
opencode service start
```

## Options du plugin

| Option | Rôle |
|---|---|
| `apiKey` | Ta clé API Command Code. Si absente, le plugin lit `CMD_API_KEY` puis `COMMAND_CODE_API_KEY`. |
| `apiBase` | Base amont, par défaut `https://api.commandcode.ai`. Utile pour un mock. |
| `url` | Force l'usage d'un pont **externe** au lieu du pont interne. |
| `token` | Token du pont externe, utilisé seulement avec `url`. |

## Mode manuel — pont séparé

Utile pour déboguer ou si tu veux isoler le pont d'OpenCode.

```bash
export CMD_API_KEY='ta-clé-API-Command-Code'
export COMMANDCODE_GO_BRIDGE_TOKEN='un-secret-local-long'
node proxy.mjs
```

Puis dans `opencode.jsonc` :

```jsonc
{
  "plugins": [
    {
      "package": "/chemin/absolu/vers/commandcode",
      "options": {
        "url": "http://127.0.0.1:8787/v1",
        "token": "un-secret-local-long"
      }
    }
  ]
}
```

Le token du plugin et celui du pont doivent être identiques. Dans ce mode, `plugin.ts` ne démarre pas de pont interne.

## Variables du pont

| Variable | Défaut | Rôle |
|---|---|---|
| `CMD_API_KEY` / `COMMAND_CODE_API_KEY` | — | Clé Command Code. Lue par le plugin en mode automatique, et par `proxy.mjs` en mode manuel. |
| `COMMANDCODE_GO_BRIDGE_TOKEN` | — | Token du pont **externe** uniquement. |
| `COMMANDCODE_GO_BRIDGE_URL` | — | Force un pont externe (équivalent à l'option `url`). |
| `COMMANDCODE_GO_API_BASE` | `https://api.commandcode.ai` | Base amont, dans les deux modes. |
| `COMMANDCODE_GO_HOST` | `127.0.0.1` | Écoute de `proxy.mjs` en mode manuel. |
| `COMMANDCODE_GO_PORT` | `8787` | Port de `proxy.mjs` en mode manuel. Le pont interne utilise un port éphémère. |
| `COMMANDCODE_GO_CLI_VERSION` | `1.88.0` | Header `x-command-code-version`. |
| `COMMANDCODE_GO_MAX_TOKENS` | `64000` | Plafond de `max_tokens`. |
| `COMMANDCODE_GO_TIMEOUT_MS` | `900000` | Timeout total de la requête amont. |
| `COMMANDCODE_GO_WORKDIR` | `process.cwd()` | `config.workingDir` de secours. En usage normal, le plugin transmet le dossier de sa location (le projet). |

## Tests

```bash
node --test proxy.test.mjs
```

Les tests couvrent :

- conversion système / utilisateur / assistant / outils / résultats d'outils ;
- synthèse d'un résultat manquant pour un appel d'outil interrompu ;
- troncature déterministe des identifiants d'outils à 64 caractères ;
- images en data URL ;
- flux SSE complet avec texte, raisonnement, appel d'outil, `finish_reason` et usage ;
- rejet sans token local.

Le mode automatique a été validé de bout en bout avec un faux serveur `/alpha/generate` : OpenCode 2.2.x → plugin → pont interne → SSE. Aucun test avec une vraie clé Go n'a été fait dans ce dépôt.

## Limites connues

- **Tous** les modèles du catalogue `commandcode` sont copiés, y compris ceux que le plan Go ne couvre pas. Une erreur `403 upgrade_required` remonte alors dans OpenCode. Il n'existe pas de liste publique des modèles Go.
- Le pont ne gère que `stream: true`.
- Les images doivent être des data URLs `data:<mime>;base64,...`. Les URLs HTTP ne sont pas récupérées.
- Le raisonnement est transmis en `reasoning_content` ; les variantes de raisonnement propres à Anthropic sont supprimées de la copie du catalogue.
- `threadId` est dérivé de la session OpenCode (`x-opencode-session`) pour garder un fil stable. Sans session, un UUID aléatoire est généré par requête.
- Le header `x-command-code-version` est épinglé. Un changement du CLI peut casser le pont ; il n'y a pas de SLA.
- En mode automatique, la clé API est détenue par le processus OpenCode. Préfère `{env:CMD_API_KEY}` à une clé écrite en clair dans `opencode.jsonc`.
- Le pont interne écoute uniquement sur `127.0.0.1`, avec un token aléatoire par processus.
- La génération de titre d'OpenCode peut choisir un autre modèle du provider (observé : `gpt-6-luna`) ; si ce modèle n'est pas inclus dans Go, seule la génération de titre échoue.

## Dépannage

- `commandcode-go` absent de `opencode models` : la clé API manque, le plugin n'est pas chargé, ou le catalogue `commandcode` n'est pas encore disponible.
- `401 Invalid bridge token` : uniquement en mode manuel ; le token du plugin et celui du pont diffèrent.
- `403 upgrade_required` : le modèle n'est pas inclus dans le plan Go.
- `502` : le pont n'arrive pas à joindre Command Code, ou l'endpoint a changé.
- `Command Code stream ended before the finish event` : flux amont tronqué ou version CLI incompatible.
- En cas de doute, lance `opencode --standalone --print-logs models` et cherche `[commandcode-go]`.

## Fichiers

- `plugin.ts` — provider OpenCode + démarrage du pont interne.
- `proxy.mjs` — pont OpenAI ↔ `/alpha/generate`, importable ou lançable seul.
- `proxy.test.mjs` — tests.
- `package.json` — point d'entrée du plugin quand OpenCode le charge par dossier.
- `ETUDE-FAISABILITE-COMMANDCODE-OPENCODE.md` — étude complète et avertissements contractuels.
