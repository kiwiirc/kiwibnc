#!/bin/bash

# Script de recherche dans les logs KiwiBNC
# Usage: ./search-logs.sh [options]

set -e

# Valeurs par défaut
DB_PATH="$HOME/.kiwibnc/messages.db"
USERS_DB_PATH="$HOME/.kiwibnc/users.db"
USERNAME=""
USER_ID=""
NETWORK_ID=""
CHANNEL=""
SEARCH_TEXT=""
DATE_MIN=""
DATE_MAX=""
LIMIT=100
OUTPUT_FORMAT="table"

# Fonction d'aide
show_help() {
    cat << EOF
Usage: $0 [OPTIONS]

Recherche dans les logs de messages KiwiBNC

OPTIONS:
    -d, --database PATH       Chemin vers messages.db (défaut: ~/.kiwibnc/messages.db)
    --users-db PATH           Chemin vers users.db (défaut: ~/.kiwibnc/users.db)
    -U, --username NAME       Nom d'utilisateur (recommandé)
    -u, --user-id ID          ID de l'utilisateur (alternatif à --username)
    -n, --network-id ID       ID du réseau (requis)
    -c, --channel NAME        Nom du salon, ex: #general (requis)
    -s, --search TEXT         Texte à rechercher (requis)
    -m, --min-date DATE       Date minimale (format: YYYY-MM-DD ou YYYY-MM-DD HH:MM:SS)
    -x, --max-date DATE       Date maximale (format: YYYY-MM-DD ou YYYY-MM-DD HH:MM:SS)
    -l, --limit N             Limite de résultats (défaut: 100)
    -f, --format FORMAT       Format de sortie: table|json|csv (défaut: table)
    -h, --help                Afficher cette aide

EXEMPLES:
    # Recherche basique avec nom d'utilisateur
    $0 -U alice -n 1 -c "#general" -s "error"
    
    # Recherche avec période
    $0 -U alice -n 1 -c "#general" -s "bug" -m "2024-01-01" -x "2024-12-31"
    
    # Avec timestamps précis
    $0 -U alice -n 1 -c "#general" -s "crash" -m "2024-06-15 10:00:00" -x "2024-06-15 18:00:00"
    
    # Export JSON
    $0 -U alice -n 1 -c "#general" -s "warning" -f json > results.json
    
    # Avec user-id directement (si vous le connaissez)
    $0 -u 1 -n 1 -c "#general" -s "error"

EOF
    exit 0
}

# Conversion date vers timestamp en millisecondes
date_to_timestamp() {
    local date_str="$1"
    if [[ "$date_str" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
        # Format YYYY-MM-DD -> ajouter 00:00:00
        date_str="$date_str 00:00:00"
    fi
    # Utilise date pour convertir (compatible Linux et macOS)
    date -d "$date_str" +%s%3N 2>/dev/null || date -j -f "%Y-%m-%d %H:%M:%S" "$date_str" +%s%3N 2>/dev/null || {
        echo "Erreur: format de date invalide '$date_str'" >&2
        echo "Formats acceptés: YYYY-MM-DD ou YYYY-MM-DD HH:MM:SS" >&2
        exit 1
    }
}

# Parse des arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        -d|--database)
            DB_PATH="$2"
            shift 2
            ;;
        --users-db)
            USERS_DB_PATH="$2"
            shift 2
            ;;
        -U|--username)
            USERNAME="$2"
            shift 2
            ;;
        -u|--user-id)
            USER_ID="$2"
            shift 2
            ;;
        -n|--network-id)
            NETWORK_ID="$2"
            shift 2
            ;;
        -c|--channel)
            CHANNEL="$2"
            shift 2
            ;;
        -s|--search)
            SEARCH_TEXT="$2"
            shift 2
            ;;
        -m|--min-date)
            DATE_MIN="$2"
            shift 2
            ;;
        -x|--max-date)
            DATE_MAX="$2"
            shift 2
            ;;
        -l|--limit)
            LIMIT="$2"
            shift 2
            ;;
        -f|--format)
            OUTPUT_FORMAT="$2"
            shift 2
            ;;
        -h|--help)
            show_help
            ;;
        *)
            echo "Option inconnue: $1" >&2
            echo "Utilisez -h ou --help pour l'aide" >&2
            exit 1
            ;;
    esac
done

# Vérification des paramètres requis
if [[ -z "$USERNAME" ]] && [[ -z "$USER_ID" ]]; then
    echo "Erreur: Vous devez spécifier --username ou --user-id" >&2
    echo "Utilisez -h ou --help pour plus d'informations" >&2
    exit 1
fi

if [[ -z "$NETWORK_ID" ]] || [[ -z "$CHANNEL" ]] || [[ -z "$SEARCH_TEXT" ]]; then
    echo "Erreur: Paramètres requis manquants" >&2
    echo "Requis: --network-id, --channel, --search" >&2
    echo "Requis aussi: --username OU --user-id" >&2
    echo "Utilisez -h ou --help pour plus d'informations" >&2
    exit 1
fi

# Résoudre le username en user_id si nécessaire
if [[ -n "$USERNAME" ]] && [[ -z "$USER_ID" ]]; then
    # Vérifier que la base users existe
    if [[ ! -f "$USERS_DB_PATH" ]]; then
        echo "Erreur: Base de données users introuvable: $USERS_DB_PATH" >&2
        echo "Utilisez --users-db pour spécifier un autre chemin" >&2
        exit 1
    fi
    
    # Chercher l'ID de l'utilisateur
    USER_ID=$(sqlite3 "$USERS_DB_PATH" "SELECT id FROM users WHERE username = '$USERNAME' LIMIT 1;" 2>/dev/null)
    
    if [[ -z "$USER_ID" ]]; then
        echo "Erreur: Utilisateur '$USERNAME' introuvable dans la base" >&2
        echo "Utilisateurs disponibles:" >&2
        sqlite3 -column "$USERS_DB_PATH" "SELECT id, username FROM users ORDER BY id;"
        exit 1
    fi
fi

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

# Conversion des dates si fournies
TIMESTAMP_MIN=""
TIMESTAMP_MAX=""
if [[ -n "$DATE_MIN" ]]; then
    TIMESTAMP_MIN=$(date_to_timestamp "$DATE_MIN")
fi
if [[ -n "$DATE_MAX" ]]; then
    TIMESTAMP_MAX=$(date_to_timestamp "$DATE_MAX")
fi

# Construction de la requête SQL
SQL_QUERY="SELECT
    datetime(logs.time/1000, 'unixepoch', 'localtime') as date,
    d_prefix.data as nick,
    d_data.data as message
FROM logs
LEFT JOIN data d_buffer ON logs.bufferref = d_buffer.id
LEFT JOIN data d_prefix ON logs.prefixref = d_prefix.id
LEFT JOIN data d_data ON logs.dataref = d_data.id
WHERE
    logs.user_id = $USER_ID
    AND logs.network_id = $NETWORK_ID
    AND logs.bufferref = (SELECT id FROM data WHERE data = '$CHANNEL')"

# Ajout de la condition de date min si fournie
if [[ -n "$TIMESTAMP_MIN" ]]; then
    SQL_QUERY="$SQL_QUERY
    AND logs.time >= $TIMESTAMP_MIN"
fi

# Ajout de la condition de date max si fournie
if [[ -n "$TIMESTAMP_MAX" ]]; then
    SQL_QUERY="$SQL_QUERY
    AND logs.time <= $TIMESTAMP_MAX"
fi

# Ajout de la recherche textuelle
SQL_QUERY="$SQL_QUERY
    AND d_data.data LIKE '%$SEARCH_TEXT%'
ORDER BY logs.time ASC
LIMIT $LIMIT;"

# Exécution de la requête selon le format de sortie
case "$OUTPUT_FORMAT" in
    table)
        echo "=== Résultats de recherche ==="
        echo "Base de données: $DB_PATH"
        [[ -n "$USERNAME" ]] && echo "Utilisateur: $USERNAME (ID: $USER_ID)" || echo "User ID: $USER_ID"
        echo "Salon: $CHANNEL"
        echo "Recherche: '$SEARCH_TEXT'"
        [[ -n "$DATE_MIN" ]] && echo "Date min: $DATE_MIN"
        [[ -n "$DATE_MAX" ]] && echo "Date max: $DATE_MAX"
        echo ""
        
        # Fonction pour nettoyer les codes couleur IRC
        clean_irc_colors() {
            # Supprime les codes de couleur IRC et de formatage
            # \x03 = couleur, \x02 = gras, \x1F = souligné, \x16 = inverse, \x0F = reset
            local text="$1"
            # Supprimer codes couleur (format: ^C##,## ou ^C##)
            text=$(echo "$text" | sed -E 's/'$'\x03''[0-9]{1,2}(,[0-9]{1,2})?//g')
            # Supprimer autres codes de formatage
            text=$(echo "$text" | sed 's/'$'\x02''//g; s/'$'\x1F''//g; s/'$'\x16''//g; s/'$'\x0F''//g')
            echo "$text"
        }
        
        # Récupérer et formater les résultats
        COUNT=0
        sqlite3 -separator $'\t' "$DB_PATH" "$SQL_QUERY" | while IFS=$'\t' read -r date nick message; do
            # Nettoyer les codes couleur IRC
            clean_message=$(clean_irc_colors "$message")
            
            # Afficher avec un format lisible
            echo "┌─ [$date] $nick"
            
            # Découper le message en lignes si nécessaire et indenter
            if command -v fold &> /dev/null; then
                echo "$clean_message" | fold -s -w 100 | sed 's/^/│  /'
            else
                # Fallback si fold n'est pas disponible
                echo "$clean_message" | sed 's/^/│  /'
            fi
            echo "└─────"
            echo ""
            
            COUNT=$((COUNT + 1))
        done
        
        # Compte le nombre de résultats
        COUNT_QUERY="${SQL_QUERY/SELECT*/SELECT COUNT(*) as count}"
        COUNT_QUERY="${COUNT_QUERY/ORDER BY*/}"
        COUNT_QUERY="${COUNT_QUERY/LIMIT*/}"
        COUNT=$(sqlite3 "$DB_PATH" "$COUNT_QUERY")
        
        echo ""
        echo "Total: $COUNT résultat(s)"
        ;;
    json)
        sqlite3 -json "$DB_PATH" "$SQL_QUERY"
        ;;
    csv)
        sqlite3 -csv -header "$DB_PATH" "$SQL_QUERY"
        ;;
    *)
        echo "Erreur: Format de sortie invalide: $OUTPUT_FORMAT" >&2
        echo "Formats valides: table, json, csv" >&2
        exit 1
        ;;
esac
