# Command Code Go dans OpenCode — provider + pont local

[English](README.md) · **Français**

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

Dépôt : <https://github.com/Sokoshy/opencode-commandcode-go>.

## Avertissement

Ce montage est **non officiel**. Le plan Go de Command Code n'inclut pas l'accès à la Provider API, `/alpha/generate` est le transport interne du CLI, et les conditions d'utilisation interdisent le reverse engineering et le transfert d'accès. Le pont ne contourne ni les quotas ni les droits du plan Go. À réserver à un usage local et expérimental ; ne pas distribuer.

## Démarrage rapide — mode automatique

Tu n'as besoin que de ta clé API Command Code (la même que celle utilisée avec Pi). Pas de `proxy.mjs` à lancer et pas de clé dans la configuration : OpenCode la demande via `/connect`.

### 1. Installer le plugin

#### Avec `opencode plugin add` (recommandé)

Le dépôt GitHub s'installe directement :

```bash
opencode plugin add github:Sokoshy/opencode-commandcode-go
```

La commande installe le plugin et l'ajoute à la configuration **globale** (`~/.config/opencode/opencode.json` sous Linux). L'entrée est juste la chaîne du paquet ; aucune option n'est nécessaire :

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "github:Sokoshy/opencode-commandcode-go"
  ]
}
```

Mettre à jour ou désinstaller :

```bash
opencode plugin update github:Sokoshy/opencode-commandcode-go
opencode plugin remove github:Sokoshy/opencode-commandcode-go
```

Après l'installation, relance OpenCode — ou `opencode service restart` si tu utilises le service d'arrière-plan — pour charger le plugin.

#### Depuis Git / GitHub, avec une révision précise

`opencode plugin add` accepte les spécifications Git compatibles npm :

```bash
# branche
opencode plugin add 'github:Sokoshy/opencode-commandcode-go#main'

# tag ou commit complet
opencode plugin add 'github:Sokoshy/opencode-commandcode-go#<tag-ou-commit>'

# HTTPS
opencode plugin add 'git+https://github.com/Sokoshy/opencode-commandcode-go.git#main'

# SSH (dépôt privé ou clé déjà configurée)
opencode plugin add 'git+ssh://git@github.com/Sokoshy/opencode-commandcode-go.git#main'
```

Une branche ou un tag est revérifié par `opencode plugin update` ; un commit complet reste épinglé. Les mêmes spécifications peuvent être écrites à la main dans `plugins`.

#### Depuis un dossier local

`opencode plugin add` refuse les chemins locaux. Pour développer ou tester une copie locale, pointe directement vers le **dossier** dans `opencode.jsonc` :

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "/chemin/absolu/vers/commandcode"
  ]
}
```

Le plugin importe `proxy.mjs` : pointe vers le **dossier complet**, pas seulement vers `plugin.ts`. Remplace `/chemin/absolu/vers/commandcode` par le chemin réel du dossier.

### 2. Connecter Command Code Go

Lance OpenCode :

```bash
opencode --standalone
```

Le plugin démarre un pont local sur un port éphémère et enregistre le provider **Command Code Go**. Connecte-le comme n'importe quel provider :

```text
/connect
# Choisis Command Code Go, puis colle ta clé API Command Code.
/models
# Choisis un modèle commandcode-go/*.
```

Ou en CLI :

```bash
opencode auth login commandcode-go --method key
opencode run \
  -m commandcode-go/claude-haiku-4-5-20251001 \
  "Réponds juste: ok"
```

La clé est stockée dans le magasin d'identifiants d'OpenCode. Elle n'est pas écrite dans `opencode.jsonc` et n'a pas besoin d'être exportée dans l'environnement.

Vérification :

```bash
opencode --standalone models | grep '^commandcode-go/'
```

Attendu : `71` modèles avec le catalogue `models.dev` du 29/10/2026. Le nombre dépend du catalogue.

Si le modèle n'est pas inclus dans le plan Go, l'erreur `403 upgrade_required` remonte dans OpenCode ; essaie un autre modèle.

### Si OpenCode tourne en service d'arrière-plan

`/connect` fonctionne via le service d'arrière-plan ; la clé est stockée dans sa base de données. Si tu préfères la méthode par variable d'environnement, le service doit voir la variable :

```bash
opencode service stop
export CMD_API_KEY='ta-clé-API-Command-Code'
opencode service start
```

## Options du plugin

Aucune option n'est requise. Celles-ci servent au débogage et au pont manuel :

| Option | Rôle |
|---|---|
| `apiBase` | Base amont, par défaut `https://api.commandcode.ai`. Utile pour un mock. |
| `url` | Force l'usage d'un pont **externe** au lieu du pont interne. |
| `token` | Token du pont externe, utilisé seulement avec `url`. |
| `apiKey` | Repli historique : clé Command Code transmise au pont quand /connect n'en fournit pas. Préférer /connect. |

Migration depuis 0.1.x : la clé vient désormais du magasin d'identifiants d'OpenCode via `/connect`. L'option `apiKey` ne sert que de repli ; elle fonctionne encore si elle est définie, mais privilégiez `/connect`.

## Mode manuel — pont séparé

Utile pour déboguer ou si tu veux isoler le pont d'OpenCode.

```bash
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

Le token du plugin et celui du pont doivent être identiques. Dans ce mode, `plugin.ts` ne démarre pas de pont interne. La clé Command Code vient toujours de `/connect` ; mets `CMD_API_KEY` sur le pont seulement si tu l'appelles directement (curl, autre client). Attention : OpenCode envoie la vraie clé Command Code comme bearer token vers `url` ; n'utilise ce mode qu'en loopback ou en HTTPS.

## Variables du pont

| Variable | Défaut | Rôle |
|---|---|---|
| `CMD_API_KEY` / `COMMAND_CODE_API_KEY` | — | Clé Command Code de secours pour `proxy.mjs` quand il est appelé directement. Les requêtes normales portent la clé du credential `/connect`. |
| `COMMANDCODE_GO_BRIDGE_TOKEN` | — | Token du pont **externe** uniquement ; doit correspondre à l'option `token`. |
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
- rejet quand le token du pont manque ou est faux ;
- le mode historique où le token du pont sert lui-même de bearer token.

Le mode automatique a été validé de bout en bout avec un faux serveur `/alpha/generate` : clé stockée via l'API `/connect` → OpenCode 2.2.x → plugin → pont interne → SSE, avec la clé transmise en amont en `Authorization: Bearer`. Aucun test avec une vraie clé Go n'a été fait dans ce dépôt.

## Limites connues

- **Tous** les modèles du catalogue `commandcode` sont copiés, y compris ceux que le plan Go ne couvre pas. Une erreur `403 upgrade_required` remonte alors dans OpenCode. Il n'existe pas de liste publique des modèles Go.
- Le pont ne gère que `stream: true`.
- Les images doivent être des data URLs `data:<mime>;base64,...`. Les URLs HTTP ne sont pas récupérées.
- Le raisonnement est transmis en `reasoning_content` ; les variantes de raisonnement propres à Anthropic sont supprimées de la copie du catalogue.
- `threadId` est dérivé de la session OpenCode (`x-opencode-session`) pour garder un fil stable. Sans session, un UUID aléatoire est généré par requête.
- Le header `x-command-code-version` est épinglé. Un changement du CLI peut casser le pont ; il n'y a pas de SLA.
- En mode automatique, la clé API est stockée dans le magasin d'identifiants d'OpenCode et envoyée par OpenCode au pont interne comme bearer token. L'entrée du plugin dans `opencode.jsonc` ne contient jamais la clé.
- Le pont interne écoute uniquement sur `127.0.0.1`, exige un header `x-bridge-token` aléatoire généré par processus, et relaie le bearer token qu'OpenCode lui envoie.
- La génération de titre d'OpenCode peut choisir un autre modèle du provider (observé : `gpt-6-luna`) ; si ce modèle n'est pas inclus dans Go, seule la génération de titre échoue.

## Dépannage

- `commandcode-go` absent de `opencode models` : le plugin n'est pas chargé, ou le catalogue `commandcode` n'est pas encore disponible. Relance OpenCode après l'installation.
- `commandcode-go` absent de `/connect` : mêmes causes ; le provider est enregistré par le plugin, vérifie `opencode --standalone --print-logs models` pour `[commandcode-go]`.
- Aucune clé API Command Code : lance `/connect`, choisis **Command Code Go**, et colle la clé.
- `401 Invalid bridge token` : uniquement en mode manuel ; le token du plugin et celui du pont diffèrent.
- `403 upgrade_required` : le modèle n'est pas inclus dans le plan Go.
- `502` : le pont n'arrive pas à joindre Command Code, ou l'endpoint a changé.
- `Command Code stream ended before the finish event` : flux amont tronqué ou version CLI incompatible.
- En cas de doute, lance `opencode --standalone --print-logs models` et cherche `[commandcode-go]`.

## Fichiers

- `plugin.ts` — provider OpenCode + démarrage du pont interne.
- `proxy.mjs` — pont OpenAI ↔ `/alpha/generate`, importable ou lançable seul.
- `proxy.test.mjs` — tests.
- `package.json` — point d'entrée et métadonnées pour les installations `opencode plugin add`, Git ou par dossier.
- `ETUDE-FAISABILITE-COMMANDCODE-OPENCODE.md` — étude complète et avertissements contractuels.
- `README.md` — version anglaise de ce document.
