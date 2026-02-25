#!/bin/bash

# Script pour lister les utilisateurs et réseaux dans KiwiBNC
# Utile pour trouver les IDs nécessaires au script search-logs.sh

set -e

DB_PATH="$HOME/.kiwibnc/users.db"

# Parse des arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        -d|--database)
            DB_PATH="$2"
            shift 2
            ;;
        -h|--help)
            cat << EOF
Usage: $0 [OPTIONS]

Liste les utilisateurs et leurs réseaux configurés dans KiwiBNC

OPTIONS:
    -d, --database PATH       Chemin vers users.db (défaut: ~/.kiwibnc/users.db)
    -h, --help                Afficher cette aide

EOF
            exit 0
            ;;
        *)
            echo "Option inconnue: $1" >&2
            exit 1
            ;;
    esac
done

# Vérification de l'existence de la base de données
if [[ ! -f "$DB_PATH" ]]; then
    echo "Erreur: Base de données introuvable: $DB_PATH" >&2
    exit 1
fi

# Vérification de sqlite3
if ! command -v sqlite3 &> /dev/null; then
    echo "Erreur: sqlite3 n'est pas installé" >&2
    exit 1
fi

echo "=== Utilisateurs et Réseaux KiwiBNC ==="
echo "Base de données: $DB_PATH"
echo ""

# Liste les utilisateurs
echo "--- UTILISATEURS ---"
sqlite3 -header -column "$DB_PATH" "SELECT id, username FROM users ORDER BY id;"

echo ""
echo "--- RÉSEAUX PAR UTILISATEUR ---"

# Pour chaque utilisateur, liste ses réseaux
USERS=$(sqlite3 "$DB_PATH" "SELECT id FROM users ORDER BY id;")

for USER_ID in $USERS; do
    USERNAME=$(sqlite3 "$DB_PATH" "SELECT username FROM users WHERE id = $USER_ID;")
    echo ""
    echo "Utilisateur: $USERNAME (ID: $USER_ID)"
    
    NETWORK_COUNT=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM user_networks WHERE user_id = $USER_ID;")
    
    if [ "$NETWORK_COUNT" -eq 0 ]; then
        echo "  Aucun réseau configuré"
    else
        sqlite3 -header -column "$DB_PATH" "
            SELECT 
                id as 'Network ID',
                name as 'Nom',
                host as 'Serveur',
                port as 'Port',
                nick as 'Nick'
            FROM user_networks 
            WHERE user_id = $USER_ID 
            ORDER BY id;
        "
    fi
done

echo ""
echo "=== Utilisation ==="
echo "Pour rechercher dans les logs, utilisez:"
echo "./search-logs.sh -u USER_ID -n NETWORK_ID -c \"#channel\" -s \"texte\""
