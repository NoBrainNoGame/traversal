# Traversal (local / LAN)

Version jouable à deux du jeu [Traversal](https://www.traversalgame.com/rules), faite avec three.js (plateau 3D),
pixi.js (interface) et @ghom/booyah (state machines). Projet perso, non officiel.

## Origine

Le jeu n'est pas de moi : il vient de [traversalgame.com](https://www.traversalgame.com) et de
[darkfireXXI/board_game](https://github.com/darkfireXXI/board_game). Ce repository est juste un portage en
TypeScript pour jouer avec mes amis, avec les thèmes visuels que je veux, et qui corrige les miss clicks de la
version .com.

## Lancer une partie

```sh
npm install
npm start          # build + serveur sur le port 3000 (PORT=xxxx pour changer)
```

- Toi : ouvre `http://localhost:3000`
- Ton ami (même réseau) : ouvre l'adresse `http://<ton-ip>:3000` affichée dans le terminal et dans le lobby

Le premier connecté joue Rouge, le second Bleu, les suivants regardent. Recharger la page garde sa place.

## Commandes

- Clic gauche : sélectionner une pièce / jouer un coup (vert = déplacement, cyan = saut d'Explorateur, rouge = attaque, flèche dorée = sortie)
- Clic gauche glissé : tourner et incliner le plateau (la caméra et la lumière restent fixes)
- Clic droit glissé : déplacer le plateau · Molette : zoom · Échap : désélectionner

Un glissé n'est jamais pris pour un clic (tolérance de 6 px), et cliquer sur une autre de tes pièces change juste la sélection.

## Code

- `shared/rules.ts` : règles, génération de terrain, coups légaux (utilisé par le serveur et le client)
- `server/server.ts` : serveur HTTP + WebSocket, fait autorité sur la partie
- `src/flow.ts` : state machines booyah (connexion → lobby → partie → fin ; et tour : attente / sélection / envoi)
- `src/board3d.ts` : rendu three.js et sélection · `src/hud.ts` : interface pixi.js
