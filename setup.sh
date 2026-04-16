#!/bin/bash
# ===================================================
# SafariMagic Mirror - Script de configuration
# Les French Twins
# ===================================================
#
# Ce script détecte l'IP locale de ton Mac et met à jour
# automatiquement l'app SafariMagic avec la bonne adresse.
#
# Usage: ./setup.sh
# ===================================================

echo ""
echo "🪄 SafariMagic Mirror - Configuration"
echo "═══════════════════════════════════════"
echo ""

# Détecter l'IP locale
LOCAL_IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null)

if [ -z "$LOCAL_IP" ]; then
    echo "⚠️  Impossible de détecter l'IP WiFi."
    echo "   Vérifie que tu es connecté au WiFi."
    echo ""
    read -p "Entre ton IP manuellement: " LOCAL_IP
fi

echo "📡 IP détectée: $LOCAL_IP"
echo ""

# Mettre à jour BrowserModel.swift
SWIFT_FILE="../SafariMagic/SafariMagic/BrowserModel.swift"
if [ -f "$SWIFT_FILE" ]; then
    sed -i '' "s|static let mirrorServerURL = \"http://.*:3333\"|static let mirrorServerURL = \"http://$LOCAL_IP:3333\"|" "$SWIFT_FILE"
    echo "✅ App SafariMagic configurée avec http://$LOCAL_IP:3333"
else
    echo "⚠️  Fichier BrowserModel.swift non trouvé."
    echo "   Met à jour manuellement la ligne mirrorServerURL dans BrowserModel.swift:"
    echo "   static let mirrorServerURL = \"http://$LOCAL_IP:3333\""
fi

echo ""
echo "📋 Prochaines étapes:"
echo "   1. Lance le serveur:  cd SafariMagic-Mirror && npm start"
echo "   2. Rebuild l'app dans Xcode (Cmd+R)"
echo "   3. Ouvre http://$LOCAL_IP:3333 sur l'autre appareil"
echo "   4. Fais une recherche dans l'app → elle s'ouvre sur l'autre!"
echo ""
