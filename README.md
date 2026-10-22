# Traversal (local / LAN / traversalgame.com)

**Jouer en ligne : https://nobrainnogame.github.io/traversal/** (parties traversalgame.com, sans rien installer)

Client 3D du jeu [Traversal](https://www.traversalgame.com/rules), fait avec three.js (plateau 3D),
pixi.js (interface) et @ghom/booyah (state machines). On peut y jouer à deux en local ou en réseau,
ou jouer des parties du site officiel depuis ce client. Projet perso, non officiel.

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

### Chat et webcam

- Chat en bas à droite (Entrée pour écrire), avec des emotes Twitch / FrankerFaceZ : `:kappa:`, `:harold:`,
  `:pepefrog:`, `:feelsbadman:`, `:pepehands:`, `:pepelaugh:`, `:kekw:`, `:lulw:`, `:monkas:` (bouton grenouille pour les choisir).
- Webcam entre les deux joueurs (menu pause → « Activer la webcam »), en pair à pair (WebRTC), le serveur ne fait que
  relayer la mise en relation. Les navigateurs ne donnent la caméra qu'aux pages sécurisées : ton ami doit ouvrir
  l'adresse **https** (port 3001, `PORT + 1`), affichée dans le terminal et le lobby, et accepter l'avertissement
  du certificat auto-signé. Sur `localhost`, l'adresse http suffit.

## Jouer sur traversalgame.com

Depuis [la version en ligne](https://nobrainnogame.github.io/traversal/) ou le lobby local :
« Contre un bot », « Matchmaking » ou « Inviter un ami » (lien d'invitation à envoyer).

- La première fois, le client demande l'e-mail et le mot de passe de ton compte traversalgame.com. La session reste
  ensuite dans ce navigateur (menu pause ou lobby → « Se déconnecter »).
- Le site n'accepte que les requêtes venant de lui-même et garde la session dans des cookies inaccessibles à une
  autre page : le client passe donc par un petit relais Cloudflare (`relay/worker.ts`). Il appelle l'API au nom de
  www.traversalgame.com et rend la session au client sous forme de jeton. Il ne stocke rien.
- Le site reste l'arbitre : il crée la partie, l'état arrive en direct par WebSocket, et les coups légaux
  sont ceux qu'il fournit.
- La barre du haut affiche les pseudos et les pendules (10 min par joueur). Une proposition de nulle
  de l'adversaire ouvre une fenêtre Accepter / Refuser.
- Si ton compte a déjà une partie en cours sur le site, elle est reprise au lieu d'en créer une nouvelle.
- Le menu pause permet de proposer la nulle ou d'abandonner (avec confirmation).
- Pour l'instant : terrain aléatoire, parties non classées, bot de niveau 5.

## Le jeu

- Relief continu : chaque case a un plateau plat, reliées par des pentes. Murets sur les côtés, barrières de
  lumière rouge / bleue sur les bords à atteindre.
- Paysage vivant autour du plateau : l'eau ruisselle sur les cases bleues et remplit les creux du terrain,
  arbres, buissons, rochers, fleurs et herbes qui ondulent au vent, oiseaux en vol, papillons, lapins qui
  sautillent, poissons qui bondissent hors des lacs, poussières de lumière.
- Au loin, un monde fantastique : îles flottantes et leurs cascades, flèches de cristal, chaînes de montagnes,
  nuages, planète à anneaux sur un ciel du matin. Le terrain devient progressivement transparent jusqu'à sa limite.
- Sons synthétisés (aucun fichier audio) :
  - une cloche étouffée quand c'est ton tour (après l'animation du coup adverse) ;
  - le clairon en fin de partie : le réveil pour une victoire, la sonnerie aux morts sinon ;
  - les pions : roulade et écrasement de la Sentinelle, sauts, bêlement et charge de la chèvre, pas et coup de
    lance de l'Avant-garde, carillon quand un pion sort du plateau ;
  - l'interface : sélection d'un pion, survol d'une case jouable, coup refusé, message de chat, proposition de nulle.
  - Menu pause → « Couper le son » (mémorisé).
- Personnages selon leur rôle : l'Explorateur est un éclaireur sur une chèvre avec un étendard, l'Avant-garde
  un soldat avec lance et bouclier, la Sentinelle une grosse brute. Badges de mouvement (vert) et de force
  (rouge) à leurs pieds.
- Survoler un pion affiche sa portée, quel que soit le tour : coût de déplacement peint sur les cases libres,
  bonus / malus d'attaque sur les ennemis (gris si l'attaque serait perdue).
- Animations : la Sentinelle se met en boule et roule, et pour tuer elle saute sur l'ennemi, l'écrase et rebondit
  sur sa case. La chèvre de l'Explorateur saute de case en case, et pour tuer elle charge tête baissée et envoie
  l'ennemi voler. L'Avant-garde marche au pas, et pour tuer elle abaisse sa lance et se fend : l'ennemi tombe à la renverse.
- Quand l'adversaire joue, la caméra se place de trois quarts (côté terrain le plus bas, plongée de 30°), zoome sur
  le pion, attend d'être dessus pour le laisser bouger, le suit, puis revient en douceur à la vue que tu avais choisie.
  Son dernier coup reste marqué en orange (case de départ remplie, cadre autour du pion).

## Menu pause (Échap)

Reprendre · relancer la partie · échanger les camps · nouvelle partie locale sur un autre terrain · partie sur
traversalgame.com (bot, matchmaking, invitation) ou retour au local · proposer la nulle / abandonner sur le site ·
recentrer la vue · couper le son · webcam et micro · déconnexion du compte traversalgame.com. En ligne, seules les options du site restent.

## Commandes

- Survol d'un pion : sa portée, et sa fiche en bas à gauche
- Clic gauche : sélectionner une pièce / jouer un coup (vert = déplacement, cyan = saut d'Explorateur, rouge = attaque, flèche dorée = sortie)
- Clic gauche glissé : déplacer le plateau · Molette : zoom
- Échap : désélectionner, sinon ouvrir / fermer le menu pause · Entrée : écrire dans le chat
- Clic droit glissé : tourner et incliner le plateau (la caméra et la lumière restent fixes) ; en l'inclinant
  vers l'horizon, on voit le paysage lointain

Un glissé n'est jamais pris pour un clic (tolérance de 6 px), et cliquer sur une autre de tes pièces change juste la sélection.

## Code

- `shared/rules.ts` : règles, génération de terrain, coups légaux et portée (utilisé par le serveur et le client)
- `server/server.ts` : serveur HTTP + HTTPS (auto-signé, pour la webcam) + WebSocket, fait autorité sur la partie locale, relaie le chat et la signalisation WebRTC
- `src/host.ts` : d'où vient la partie (serveur local, ou traversalgame.com joué depuis la page)
- `src/official.ts` : parties sur traversalgame.com (création, traduction des états et des coups) · `src/relay.ts` : compte et appels à l'API via le relais · `src/login.ts` : formulaire de connexion
- `relay/worker.ts` : le relais Cloudflare (`npm run relay:deploy`)
- `src/flow.ts` : state machines booyah (connexion → lobby → partie → fin ; et tour : attente / sélection / envoi)
- `src/board3d.ts` : rendu three.js et sélection · `src/scenery.ts` : relief, décor, barrières · `src/characters.ts` : personnages et badges
- `src/water.ts` : eau animée · `src/nature.ts` : faune et flore · `src/landscape.ts` : ciel et paysage lointain · `src/shading.ts` : vent et fondu du terrain
- `src/motion.ts` : animations des pions · `src/sound.ts` : effets sonores, cloche et clairon
- `src/hud.ts` : interface pixi.js · `src/pause.ts` : menu pause
- `src/chat.ts` : chat et emotes · `src/webcam.ts` : webcams en WebRTC

La version en ligne est construite par `npm run build:pages` (sans serveur local : ni partie locale, ni chat, ni webcam)
et publiée sur GitHub Pages à chaque push sur `main` (`.github/workflows/pages.yml`).
