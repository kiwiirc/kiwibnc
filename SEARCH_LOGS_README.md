# Scripts de recherche dans les logs KiwiBNC

Deux scripts utilitaires pour rechercher dans les logs de messages KiwiBNC.

## Scripts disponibles

### 1. `list-users-networks.sh` - Lister les utilisateurs et réseaux

Ce script affiche tous les utilisateurs et leurs réseaux configurés pour vous aider à trouver les IDs nécessaires.

**Usage :**
```bash
./list-users-networks.sh
```

**Options :**
- `-d, --database PATH` : Chemin vers users.db (défaut: ~/.kiwibnc/users.db)
- `-h, --help` : Afficher l'aide

**Exemple de sortie :**
```
--- UTILISATEURS ---
id  username
--  --------
1   john

--- RÉSEAUX PAR UTILISATEUR ---
Utilisateur: john (ID: 1)
Network ID  Nom        Serveur          Port  Nick
----------  ---------  ---------------  ----  ----
1           Freenode   irc.freenode.net 6667  john_irc
2           Libera     irc.libera.chat  6667  john
```

### 2. `search-logs.sh` - Rechercher dans les logs

Recherche du texte dans les messages d'un salon spécifique avec filtrage par dates.

**Usage :**
```bash
./search-logs.sh [OPTIONS]
```

**Options requises :**
- `-U, --username NAME` : Nom d'utilisateur (recommandé)
  OU `-u, --user-id ID` : ID de l'utilisateur (si vous connaissez l'ID directement)
- `-n, --network-id ID` : ID du réseau (obtenu avec list-users-networks.sh)
- `-c, --channel NAME` : Nom du salon (ex: #general, #support)
- `-s, --search TEXT` : Texte à rechercher dans les messages

**Options optionnelles :**
- `-d, --database PATH` : Chemin vers messages.db (défaut: ~/.kiwibnc/messages.db)
- `--users-db PATH` : Chemin vers users.db (défaut: ~/.kiwibnc/users.db)
- `-m, --min-date DATE` : Date minimale (format: YYYY-MM-DD ou YYYY-MM-DD HH:MM:SS)
- `-x, --max-date DATE` : Date maximale (format: YYYY-MM-DD ou YYYY-MM-DD HH:MM:SS)
- `-l, --limit N` : Limite de résultats (défaut: 100)
- `-f, --format FORMAT` : Format de sortie: table|json|csv (défaut: table)
- `-h, --help` : Afficher l'aide

## Exemples d'utilisation

### 1. Trouver vos IDs d'utilisateur et réseau
```bash
./list-users-networks.sh
# Note l'ID réseau pour les commandes suivantes (le nom d'utilisateur suffit)
```

### 2. Recherche basique
Rechercher le mot "error" dans #general avec votre nom d'utilisateur :
```bash
./search-logs.sh -U alice -n 1 -c "#general" -s "error"
```

### 3. Recherche avec période spécifique
Rechercher "bug" en 2024 :
```bash
./search-logs.sh -U alice -n 1 -c "#general" -s "bug" \
  -m "2024-01-01" -x "2024-12-31"
```

### 4. Recherche avec timestamps précis
Rechercher "crash" le 15 juin 2024 entre 10h et 18h :
```bash
./search-logs.sh -U alice -n 1 -c "#general" -s "crash" \
  -m "2024-06-15 10:00:00" -x "2024-06-15 18:00:00"
```

### 5. Export des résultats en JSON
```bash
./search-logs.sh -U alice -n 1 -c "#general" -s "warning" \
  -f json > results.json
```

### 6. Export en CSV pour Excel
```bash
./search-logs.sh -U alice -n 1 -c "#general" -s "important" \
  -f csv > export.csv
```

### 7. Augmenter la limite de résultats
Par défaut limité à 100 résultats, augmenter à 500 :
```bash
./search-logs.sh -U alice -n 1 -c "#general" -s "info" -l 500
```

### 8. Utiliser l'ID utilisateur directement (optionnel)
Si vous connaissez votre user_id, vous pouvez l'utiliser directement :
```bash
./search-logs.sh -u 1 -n 1 -c "#general" -s "error"
```

## Formats de sortie

### Table (défaut)
Affichage formaté dans la console avec en-têtes et compte total :
```
=== Résultats de recherche ===
Base de données: /home/user/.kiwibnc/messages.db
Utilisateur: alice (ID: 1)
Salon: #general
Recherche: 'error'

date                 nick     message
-------------------  -------  ---------------------------
2024-06-15 14:23:11  alice    Got an error in production
2024-06-15 15:30:45  bob      Error: Connection timeout

Total: 2 résultat(s)
```

### JSON
Sortie JSON pour traitement automatisé :
```json
[
  {
    "date": "2024-06-15 14:23:11",
    "nick": "alice",
    "message": "Got an error in production"
  }
]
```

### CSV
Format CSV pour import dans tableur :
```csv
date,nick,message
"2024-06-15 14:23:11","alice","Got an error in production"
```

## Prérequis

- `sqlite3` doit être installé sur le système
- Base de données KiwiBNC active (users.db et messages.db)

### Installation de sqlite3

**Ubuntu/Debian :**
```bash
sudo apt-get install sqlite3
```

**macOS :**
```bash
brew install sqlite3
# ou déjà préinstallé
```

**Fedora/RHEL :**
```bash
sudo dnf install sqlite
```

## Notes

- Le script accepte maintenant **le nom d'utilisateur** (`-U alice`) plutôt que l'ID, beaucoup plus pratique !
- Si l'utilisateur n'est pas trouvé, la liste des utilisateurs disponibles s'affiche automatiquement
- Les recherches sont insensibles à la casse par défaut dans SQLite
- Les caractères `%` peuvent être utilisés comme jokers dans le texte de recherche
- Les timestamps sont convertis automatiquement en heure locale
- Le script utilise les bases de données par défaut dans `~/.kiwibnc/`
- Spécifiez un chemin personnalisé avec `-d` si votre config est ailleurs

## Résolution de problèmes

### "Utilisateur 'xxx' introuvable dans la base"
Le nom d'utilisateur saisi n'existe pas. Le script affiche automatiquement la liste des utilisateurs disponibles. Vérifiez l'orthographe exacte du nom d'utilisateur.

### "Base de données introuvable"
Vérifiez que KiwiBNC a été lancé au moins une fois et que les chemins sont corrects :
```bash
ls -la ~/.kiwibnc/
```

### "Erreur: format de date invalide"
Utilisez uniquement les formats :
- `YYYY-MM-DD` (ex: 2024-01-15)
- `YYYY-MM-DD HH:MM:SS` (ex: 2024-01-15 14:30:00)

### Aucun résultat
Vérifiez que :
- Le salon commence bien par `#` (ex: `"#general"` et non `"general"`)
- Les IDs utilisateur et réseau sont corrects (utilisez `list-users-networks.sh`)
- Le texte recherché existe bien dans les messages
- La période de dates contient des messages
