<p align="center">
  <img src="src/assets/icon.png" width="96" alt="" />
</p>

<h1 align="center">VirtualDeck</h1>

<p align="center">
  Un Stream Deck virtuel pour Windows.<br />
  Un raccourci clavier ouvre une grille de boutons sous ta souris : un clic change de scène OBS, lance une animation, joue un son ou ouvre un programme.
</p>

<p align="center">
  <img src="docs/demo.gif" alt="Démo : un clic sur le deck change la scène dans OBS" width="860" />
  <br />
  <sub>Vidéo en meilleure qualité : <a href="docs/demo.mp4">docs/demo.mp4</a></sub>
</p>

---

## Fonctionnalités

- **Une grille qui s'ouvre où tu es** : `Ctrl + Maj + Espace` (modifiable) l'affiche sous la souris, par-dessus les jeux en plein écran fenêtré. `Échap` ou un clic à côté la ferme. Les touches `1` à `9` déclenchent les boutons au clavier.
- **Pilote OBS Studio et Streamlabs Desktop** : changer de scène, afficher/masquer une source, lancer une animation qui se cache toute seule, démarrer ou arrêter le live et l'enregistrement.
- **Badge LIVE** sur le bouton de la scène actuellement à l'antenne.
- **Sons** (mp3, wav, ogg…) avec réglage du volume ; un second clic coupe le son.
- **Ouvrir** un programme, un fichier ou un lien (`https://`, `spotify:`, `steam://`, `discord://`…).
- **Personnalisation** : plus de 2 000 icônes, emojis ou tes propres images, 10 couleurs ou une couleur libre, grille jusqu'à 8 × 6.
- **Export / import** de toute la configuration (sons et images compris), pour changer de PC ou partager ton deck.
- **6 langues** : français, anglais, espagnol, allemand, italien, portugais (ou automatique selon Windows).
- Tourne discrètement dans la zone de notification, peut se lancer au démarrage de Windows.

## Captures

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/deck.png" alt="Le deck" /><br /><sub>Le deck, ouvert par le raccourci</sub></td>
    <td width="50%"><img src="docs/screenshots/editor-buttons.png" alt="Éditeur de boutons" /><br /><sub>Éditeur : apparence et action de chaque bouton</sub></td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/editor-connection.png" alt="Connexion à OBS" /><br /><sub>Connexion à OBS ou Streamlabs, avec guide pas à pas</sub></td>
    <td><img src="docs/screenshots/editor-settings.png" alt="Réglages" /><br /><sub>Réglages : langue, raccourci, sauvegarde</sub></td>
  </tr>
</table>

## Installation

Pas besoin de Node.js ni de npm : l'installateur contient tout.

1. Va sur la [dernière version](https://github.com/ThomasLpgs/VirtualDeck/releases/latest) et télécharge `VirtualDeck-Setup-x.y.z.exe` dans la section **Assets**.
2. Lance-le et suis l'installateur. Windows SmartScreen peut afficher « Windows a protégé votre ordinateur » car l'app n'est pas signée par un éditeur reconnu : clique sur **Informations complémentaires** puis **Exécuter quand même**.
3. VirtualDeck s'ouvre sur l'éditeur. Ensuite, il vit dans la zone de notification (à côté de l'horloge).

Pour mettre à jour, il suffit de lancer le nouvel installateur : tes boutons sont conservés.

## Premiers pas

### 1. Connecter OBS

Dans l'onglet **Connexion** de VirtualDeck :

1. Dans OBS (version 28 ou plus), ouvre **Outils → Paramètres du serveur WebSocket** et coche **Activer le serveur WebSocket** (port `4455`).
2. Clique sur **Afficher les informations de connexion** et copie le mot de passe.
3. Colle-le dans VirtualDeck et clique sur **Se connecter**. La pastille passe au vert.

Pour **Streamlabs Desktop** : **Settings → Remote Control**, clique sur le QR code puis **Show details**, et copie l'**API Token**.

### 2. Créer tes boutons

Dans l'onglet **Boutons**, clique sur une case puis choisis :

| Action | Ce que fait le bouton |
| --- | --- |
| **Scène** | Passe sur la scène choisie (la liste vient directement d'OBS). |
| **Source / animation** | *Animation* : affiche la source, attend sa durée puis la cache (idéal pour une vidéo `.webm` transparente). *Basculer*, *Afficher*, *Masquer* : contrôle la visibilité. |
| **Enregistrer** | Démarre ou arrête l'enregistrement. |
| **Stream** | Démarre ou arrête le live. |
| **Son** | Joue un fichier audio, ou le coupe s'il est en cours. |
| **Ouvrir** | Lance un programme, un fichier ou un lien. |

Glisse-dépose les boutons pour les réorganiser. Tout est enregistré automatiquement.

### 3. Utiliser le deck

Appuie sur `Ctrl + Maj + Espace` n'importe où (ou sur la touche choisie dans **Réglages** : les touches F13 à F24 des souris et claviers programmables marchent aussi), puis clique sur un bouton.

## Sauvegarde et changement de PC

**Réglages → Exporter ma configuration** crée un fichier `.vdeck` avec tes boutons, leurs sons et leurs images. Sur l'autre PC : **Importer une configuration**. Les mots de passe et jetons de connexion ne sont jamais exportés.

## Développement

Prérequis : Node.js et Windows.

```bash
npm install
npm start          # lance l'app en mode développement
npm run dist       # crée l'installateur dans release/
npm test           # lance les tests automatiques (aussi exécutés par GitHub à chaque push)
```

Organisation du code :

```
src/
├── main.js          processus principal : fenêtres, raccourci global, icône de notification
├── config.js        lecture/écriture de la config (secrets chiffrés via safeStorage)
├── actions.js       exécution des actions des boutons
├── obs.js           client OBS WebSocket v5
├── streamlabs.js    client Streamlabs Remote Control
├── backup.js        export / import
├── i18n.js          traductions côté processus principal
├── i18n/*.json      un fichier par langue
├── deck/            la grille (fenêtre transparente)
├── editor/          l'éditeur
└── shared/          code commun aux deux fenêtres
```

Ajouter une langue : copie `src/i18n/en.json` vers `src/i18n/<code>.json`, traduis les valeurs, puis ajoute le code dans `LANGUAGES` (`src/i18n.js`). Une clé absente retombe sur l'anglais.
