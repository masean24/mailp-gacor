#!/bin/bash
# Sync virtual_mailbox_domains in Postfix main.cf from a domains file (one domain per line).
# Must be run with sudo. Usage: sudo ./sync-postfix.sh /path/to/domains.txt

set -e

MAIN_CF="/etc/postfix/main.cf"
DOMAINS_FILE="${1:-}"

if [ -z "$DOMAINS_FILE" ] || [ ! -f "$DOMAINS_FILE" ]; then
  echo "Usage: $0 /path/to/domains.txt" >&2
  exit 1
fi

# Build comma-separated list (trim empty lines, allow only valid domain chars)
DOMAINS_LIST=$(grep -v '^[[:space:]]*$' "$DOMAINS_FILE" | sed 's/[[:space:]]//g' | grep -E '^[a-zA-Z0-9][a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$' | paste -sd ',' - | sed 's/,/, /g')

# If no domains, use empty (Postfix may still need the key present)
if [ -z "$DOMAINS_LIST" ]; then
  DOMAINS_LIST=""
fi

# Replace only the virtual_mailbox_domains line; leave rest of main.cf unchanged
TMP_CF=$(mktemp)
while IFS= read -r line; do
  if [[ "$line" =~ ^virtual_mailbox_domains[[:space:]]*= ]]; then
    echo "virtual_mailbox_domains = $DOMAINS_LIST"
  else
    echo "$line"
  fi
done < "$MAIN_CF" > "$TMP_CF"

mv "$TMP_CF" "$MAIN_CF"
chown root:root "$MAIN_CF"
chmod 644 "$MAIN_CF"

postfix reload
echo "Postfix reloaded. virtual_mailbox_domains = $DOMAINS_LIST"
