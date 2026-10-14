/* ============================================================
   SUDOKU · game.js
   ------------------------------------------------------------
   So funktioniert dieses Spiel
   1. Datenmodell: Das Brett ist eine flache Liste mit 81 Zahlen
      (0 = leer, 1–9 = Ziffer). Aus Zeile z und Spalte s wird der Index
      z * 9 + s. Daneben gibt es zwei weitere 81er-Listen: die Vorgaben
      (was das Rätsel von Anfang an zeigt) und die Notizen (pro Feld
      eine Bitmaske, siehe unten).
   2. LERNKERN – Löser und Generator (TEIL 1) sind reine Funktionen ohne
      DOM und ohne Speicher:
        a) Ein Backtracking-Löser probiert Ziffern aus und nimmt sie
           zurück, sobald es nicht mehr weitergeht. Er kann nicht nur
           lösen, sondern auch ZÄHLEN, wie viele Lösungen ein Brett hat.
        b) Der Generator füllt erst ein leeres Brett zufällig komplett
           aus und löscht danach Felder, solange die Lösung eindeutig
           bleibt. Dafür braucht er genau den Lösungszähler aus a).
   3. Rendering: 81 <button>-Zellen in einem CSS-Grid. DOM statt <canvas>,
      weil Buttons Tastaturfokus, Screenreader-Beschriftung und große
      Touch-Ziele gratis mitbringen. Die Ansicht wird nach jeder Eingabe
      komplett aus dem Zustand neu gezeichnet (nur 81 Zellen, das ist
      billig und verhindert, dass Anzeige und Daten auseinanderlaufen).
   4. Eingabe: Klick/Tipp und Pfeiltasten wählen ein Feld, Tasten 1–9
      oder die Ziffernleiste setzen eine Zahl, N schaltet den Notiz-Modus.
   5. Zwei Arten von "Fehler": Die KONFLIKT-Anzeige prüft nur die Regeln
      (doppelte Zahl in Zeile/Spalte/Block). Der Schalter "Fehler sofort
      zeigen" vergleicht zusätzlich mit der gespeicherten Lösung.
   6. Speicher: laufendes Spiel pro Stufe (Brett, Notizen, Zeit) nach jeder
      Eingabe, Topliste pro Stufe ("sudoku-leicht" usw.), Punkte = Sekunden,
      weniger ist besser.
   ============================================================ */

import { lade, speichere, entferne, spielZuruecksetzen, topliste } from "./assets/storage.js";
import { bewegungReduziert, toplisteAnzeigen, gameOverDialog } from "./assets/ui.js";

/* ------------------------------------------------------------
   Konstanten
   ------------------------------------------------------------ */

/**
 * Die drei Stufen. `vorgaben` = Ziel-Anzahl der Zahlen, die das Rätsel
 * von Anfang an zeigt. Weniger Vorgaben heißen meist (nicht immer!)
 * mehr Denkarbeit. Das ist eine einfache, ehrliche Schwierigkeits-Messung;
 * echte Rätsel-Portale bewerten stattdessen, welche Lösetechniken man braucht.
 */
export const STUFEN = {
  leicht: { name: "Leicht", vorgaben: 40 },
  mittel: { name: "Mittel", vorgaben: 32 },
  schwer: { name: "Schwer", vorgaben: 26 },
};

const SPIEL = "sudoku"; // Speicherbereich für Einstellungen und Spielstände
const TOLERANZ = 2; // so viele Vorgaben über dem Ziel sind ok (siehe raetselAusVollemBrett)
const MAX_VERSUCHE = 40; // so oft darf der Generator neu ansetzen, bevor er das beste Ergebnis nimmt
const MAX_SEKUNDEN = 5999; // 99:59 – mehr kann "mm:ss" nicht darstellen
const FEIER_MS_PRO_FELD = 45; // Verzögerung der Sieg-Welle pro Feld Abstand
const FEIER_DIALOG_MS = 1500; // so lange läuft die Welle, dann kommt der Dialog

/** Speicher-Schlüssel der Topliste einer Stufe, z. B. "sudoku-leicht". */
const toplisteKey = (stufe) => `${SPIEL}-${stufe}`;
/** Speicher-Schlüssel des laufenden Spiels einer Stufe. */
const spielstandKey = (stufe) => `spielstand-${stufe}`;

/* ============================================================
   TEIL 1 · Brett-Grundlagen, Löser und Generator (rein, ohne DOM)
   Alles hier ist exportiert, damit man es in Node testen kann.
   ============================================================ */

/* ------------------------------------------------------------
   1a) Vorberechnete Tabellen
   Wir brauchen ständig "in welcher Zeile / Spalte / welchem Block liegt
   Feld i?". Das einmal auszurechnen und in Listen abzulegen ist viel
   schneller, als bei jedem Zugriff zu rechnen – und der Löser greift
   Millionen Mal darauf zu.
   Blöcke sind die neun 3×3-Kästen, von links oben (0) bis rechts unten (8).
   ------------------------------------------------------------ */
export const ZEILE = new Uint8Array(81);
export const SPALTE = new Uint8Array(81);
export const BLOCK = new Uint8Array(81);
for (let i = 0; i < 81; i++) {
  ZEILE[i] = Math.floor(i / 9);
  SPALTE[i] = i % 9;
  BLOCK[i] = Math.floor(ZEILE[i] / 3) * 3 + Math.floor(SPALTE[i] / 3);
}

/**
 * SICHTFELDER[i] = die 20 Felder, die Feld i "sieht": alle anderen in
 * derselben Zeile (8), Spalte (8) und im selben Block (4 zusätzliche,
 * die nicht schon in Zeile/Spalte liegen). Genau zwischen diesen Feldern
 * darf keine Ziffer doppelt vorkommen – das ist die ganze Sudoku-Regel.
 */
export const SICHTFELDER = Array.from({ length: 81 }, (_, i) => {
  const menge = [];
  for (let j = 0; j < 81; j++) {
    if (j !== i && (ZEILE[j] === ZEILE[i] || SPALTE[j] === SPALTE[i] || BLOCK[j] === BLOCK[i])) {
      menge.push(j);
    }
  }
  return menge;
});

/* ------------------------------------------------------------
   1b) Bitmasken: neun Ja/Nein-Antworten in EINER Zahl
   Welche Ziffern sind in einer Zeile schon vergeben? Statt einer Liste
   merken wir uns eine Zahl, in der Bit (d-1) für die Ziffer d steht:

        Ziffer:   9 8 7 6 5 4 3 2 1
        Bit:      1 0 0 0 1 0 0 1 0   = 0b100010010  →  Ziffern 2, 5 und 9 sind vergeben

   Warum? Ziffer markieren ist `maske |= 1 << (d-1)` (ODER),
   Ziffer prüfen ist `maske & (1 << (d-1))` (UND), und die Frage
   "welche Ziffern sind in Zeile, Spalte UND Block noch frei?" beantwortet
   EINE Rechnung: `ALLE & ~(zeile | spalte | block)`. Das ist um Größenordnungen
   schneller als Listen zu durchsuchen. Dieselbe Technik nutzen wir bei den
   Notizen: pro Feld eine Maske der notierten Kandidaten.
   ------------------------------------------------------------ */
const ALLE = 0b111111111; // alle neun Ziffern erlaubt = 511

/** ANZAHL_BITS[maske] = wie viele Bits sind gesetzt (= wie viele Kandidaten)? Einmal vorgerechnet. */
const ANZAHL_BITS = new Uint8Array(512);
for (let m = 1; m < 512; m++) ANZAHL_BITS[m] = ANZAHL_BITS[m >> 1] + (m & 1);

/** Wandelt eine Maske in die Liste ihrer Ziffern um, z. B. 0b100010010 → [2, 5, 9]. */
function ziffernAusMaske(maske) {
  const liste = [];
  for (let d = 1; d <= 9; d++) if (maske & (1 << (d - 1))) liste.push(d);
  return liste;
}

/** Mischt eine Liste an Ort und Stelle (Fisher-Yates) und gibt sie zurück. */
function mischen(liste, zufall) {
  for (let i = liste.length - 1; i > 0; i--) {
    const j = Math.floor(zufall() * (i + 1)); // zufälliger Platz von 0 bis i
    [liste[i], liste[j]] = [liste[j], liste[i]]; // tauschen
  }
  return liste;
}

/* ------------------------------------------------------------
   1c) Der Löser: Backtracking, das auch zählen kann
   ------------------------------------------------------------
   IDEE in drei Sätzen:
     1. Suche ein leeres Feld und probiere dort eine erlaubte Ziffer.
     2. Mach mit dem nächsten leeren Feld weiter (Rekursion).
     3. Geht es irgendwo nicht weiter (ein Feld hat KEINE erlaubte Ziffer
        mehr), war eine frühere Entscheidung falsch: Wir nehmen sie zurück
        ("Backtracking" = zurückverfolgen) und probieren die nächste Ziffer.

   Sind alle leeren Felder gefüllt, haben wir eine Lösung gefunden. Statt
   dann sofort aufzuhören, kann der Löser einfach weitersuchen und mitzählen.
   `grenze` sagt, wann Schluss ist: Für die Frage "ist die Lösung eindeutig?"
   reicht es, bis 2 zu zählen. Findet man eine zweite Lösung, ist die Antwort
   "nein" – weiterzuzählen wäre verschwendete Zeit. Genau dieses
   "Abbruch bei 2" macht den Generator später schnell.

   KLEINER TRICK MIT GROSSER WIRKUNG – "wenigste Kandidaten zuerst" (MRV):
   Wir nehmen nicht stur das nächste leere Feld, sondern IMMER das leere
   Feld mit den wenigsten erlaubten Ziffern. Hat ein Feld nur eine, ist die
   Entscheidung erzwungen (wir raten nicht, wir folgern). Hat ein Feld
   keine, erkennen wir Sackgassen sofort. Schwierige Rätsel werden so von
   Millionen auf einige Hundert/Tausend Schritte gedrückt.

   Die Rekursion ist hier unkritisch (anders als beim Flood-Fill im
   Minesweeper): Es gibt höchstens 81 leere Felder, also höchstens 81
   verschachtelte Aufrufe – weit weg von einem Stack Overflow.

   `zufall` (optional): Ist eine Zufallsfunktion angegeben, probiert der
   Löser die Ziffern in zufälliger Reihenfolge. Genau so entstehen später
   zufällige, aber gültige Bretter. Ohne `zufall` wird aufsteigend probiert.

   Rückgabe: { anzahl: gefundene Lösungen (höchstens `grenze`),
               loesung: die ERSTE gefundene Lösung (81er-Liste) oder null }
   ------------------------------------------------------------ */
export function suche(brett, grenze = 2, zufall = null) {
  const werte = Array.from(brett); // Arbeitskopie – das Original bleibt unberührt
  const zeilenMaske = new Int16Array(9); // vergebene Ziffern je Zeile
  const spaltenMaske = new Int16Array(9); // … je Spalte
  const blockMaske = new Int16Array(9); // … je Block
  const offen = []; // Indizes aller leeren Felder

  // Schritt 1: Vorgaben in die Masken eintragen und leere Felder sammeln.
  for (let i = 0; i < 81; i++) {
    const d = werte[i];
    if (d === 0) {
      offen.push(i);
      continue;
    }
    const bit = 1 << (d - 1);
    // Steht diese Ziffer schon in Zeile/Spalte/Block, widerspricht sich das
    // Brett selbst → es kann keine Lösung geben.
    if ((zeilenMaske[ZEILE[i]] | spaltenMaske[SPALTE[i]] | blockMaske[BLOCK[i]]) & bit) {
      return { anzahl: 0, loesung: null };
    }
    zeilenMaske[ZEILE[i]] |= bit;
    spaltenMaske[SPALTE[i]] |= bit;
    blockMaske[BLOCK[i]] |= bit;
  }

  let anzahl = 0;
  let loesung = null;

  /**
   * Füllt die leeren Felder offen[tiefe], offen[tiefe+1], … Gibt true zurück,
   * wenn die Suche komplett abgebrochen werden soll (Grenze erreicht).
   * Trick: offen[0 … tiefe-1] sind schon belegt, offen[tiefe …] noch nicht.
   * Das "beste" Feld tauschen wir nach offen[tiefe]; so brauchen wir keine
   * Liste zu kopieren oder zu löschen.
   */
  function weiter(tiefe) {
    // Alle Felder gefüllt → eine vollständige, regelkonforme Lösung!
    if (tiefe === offen.length) {
      anzahl++;
      if (loesung === null) loesung = werte.slice();
      return anzahl >= grenze;
    }

    // Schritt 2: das leere Feld mit den wenigsten Kandidaten finden (MRV).
    let bestePos = tiefe;
    let besteMaske = 0;
    let besteZahl = 10; // größer als jede echte Kandidatenzahl
    for (let j = tiefe; j < offen.length; j++) {
      const i = offen[j];
      // Erlaubt = nicht in Zeile, nicht in Spalte, nicht im Block vergeben.
      const maske =
        ALLE & ~(zeilenMaske[ZEILE[i]] | spaltenMaske[SPALTE[i]] | blockMaske[BLOCK[i]]);
      const n = ANZAHL_BITS[maske];
      if (n < besteZahl) {
        bestePos = j;
        besteMaske = maske;
        besteZahl = n;
        if (n <= 1) break; // 0 = Sackgasse, 1 = erzwungen: besser wird es nicht
      }
    }
    if (besteZahl === 0) return false; // Sackgasse → zurück zur letzten Entscheidung

    [offen[tiefe], offen[bestePos]] = [offen[bestePos], offen[tiefe]];
    const i = offen[tiefe];
    const zl = ZEILE[i],
      sp = SPALTE[i],
      bl = BLOCK[i];

    // Schritt 3: die Kandidaten der Reihe nach probieren (ggf. zufällig gemischt).
    let kandidaten = ziffernAusMaske(besteMaske);
    if (zufall) kandidaten = mischen(kandidaten, zufall);

    for (const d of kandidaten) {
      const bit = 1 << (d - 1);
      werte[i] = d; // Ziffer probeweise setzen …
      zeilenMaske[zl] |= bit;
      spaltenMaske[sp] |= bit;
      blockMaske[bl] |= bit;

      if (weiter(tiefe + 1)) return true; // … und mit dem Rest weitermachen

      werte[i] = 0; // ging nicht: Ziffer ZURÜCKNEHMEN (das Backtracking)
      zeilenMaske[zl] &= ~bit;
      spaltenMaske[sp] &= ~bit;
      blockMaske[bl] &= ~bit;
    }
    return false; // keine Ziffer passte → eine Ebene zurück
  }

  weiter(0);
  return { anzahl, loesung };
}

/** Löst ein Brett: gibt die (erste) Lösung als 81er-Liste zurück oder null, wenn es keine gibt. */
export function loese(brett) {
  return suche(brett, 1).loesung;
}

/**
 * Zählt die Lösungen eines Bretts, aber höchstens bis `grenze` (Standard 2).
 * Ergebnis 0 = unlösbar, 1 = eindeutig, 2 = "mindestens zwei" (mehr wollen wir nicht wissen).
 */
export function zaehleLoesungen(brett, grenze = 2) {
  return suche(brett, grenze).anzahl;
}

/* ------------------------------------------------------------
   1d) Der Generator
   ------------------------------------------------------------
   Ein gutes Sudoku-Rätsel hat GENAU EINE Lösung – sonst wäre "richtig"
   Auslegungssache. Der Generator arbeitet deshalb in zwei Phasen:

     Phase A – volles Brett: Der Löser bekommt ein LEERES Brett und
               probiert die Ziffern in zufälliger Reihenfolge. Das Ergebnis
               ist ein zufälliges, vollständig gültiges Sudoku.
     Phase B – Felder entfernen: Wir löschen Vorgaben und prüfen nach JEDEM
               Löschen mit dem Lösungszähler, ob die Lösung noch eindeutig
               ist. Wenn nicht, kommt die Zahl zurück.

   Rückwärts gedacht: Die Lösung steht von Anfang an fest (das volle Brett),
   das Rätsel entsteht, indem wir Hinweise wegnehmen.
   ------------------------------------------------------------ */

/** Phase A: ein zufälliges, vollständig gültiges Brett. */
export function zufaelligesVollesBrett(zufall = Math.random) {
  return suche(new Array(81).fill(0), 1, zufall).loesung;
}

/**
 * Phase B: Löscht Felder aus dem vollen Brett `loesung`, bis nur noch
 * ungefähr `ziel` Vorgaben übrig sind, und behält dabei die Eindeutigkeit.
 *
 * PUNKTSYMMETRIE: Wir löschen immer Paare: Feld i und sein Spiegelbild
 * 80 - i (Drehung um 180° um die Mitte, Feld 40). Das sieht wie ein "echtes"
 * Zeitungs-Sudoku aus. Das Mittelfeld hat kein Gegenstück und bildet ein
 * Einzel-"Paar". Ob es überhaupt gelöscht werden darf, entscheidet ein
 * Münzwurf: Würden wir es immer versuchen, wäre die Mitte fast immer leer –
 * ein auffälliges Muster.
 *
 * REIHENFOLGE: Die Paare werden gemischt und GENAU EINMAL durchgegangen.
 * Reicht ein einzelner Durchgang? Ja: Wenn das Löschen eines Paares bei
 * einem Brett mit mehr Vorgaben die Eindeutigkeit zerstört hat, zerstört
 * es sie bei einem Brett mit weniger Vorgaben erst recht (weniger Hinweise
 * lassen nie weniger Lösungen zu). Nach dem Durchgang ist das Rätsel also
 * "minimal": keine Vorgabe lässt sich mehr einzeln wegnehmen.
 *
 * Wir löschen nie unter `ziel`: Passt ein Paar nicht mehr hinein, wird es
 * übersprungen. Bei erhaltener Mitte ist die Vorgaben-Zahl ungerade,
 * landet also bei ziel+1 – darum die kleine TOLERANZ oben.
 */
export function raetselAusVollemBrett(loesung, ziel, zufall = Math.random) {
  const vorgaben = loesung.slice();
  const mitteBehalten = zufall() < 0.5;

  const paare = [];
  for (let i = 0; i < 40; i++) paare.push([i, 80 - i]); // 40 Paare (i = 0 … 39)
  if (!mitteBehalten) paare.push([40]); // Mitte = Einzelfeld
  mischen(paare, zufall);

  let verbleibend = 81;
  for (const paar of paare) {
    if (verbleibend <= ziel) break; // Ziel erreicht
    if (verbleibend - paar.length < ziel) continue; // würde über das Ziel hinausschießen

    const gemerkt = paar.map((i) => vorgaben[i]); // für den Fall "zurücklegen"
    for (const i of paar) vorgaben[i] = 0;

    if (zaehleLoesungen(vorgaben, 2) === 1) {
      verbleibend -= paar.length; // eindeutig geblieben → Löschung bleibt
    } else {
      paar.forEach((i, k) => {
        vorgaben[i] = gemerkt[k];
      }); // nicht mehr eindeutig → zurücklegen
    }
  }
  return vorgaben;
}

/** Ein kompletter Generator-Versuch: volles Brett + Felder entfernen. */
export function erzeugeRaetselVersuch(ziel, zufall = Math.random) {
  const loesung = zufaelligesVollesBrett(zufall);
  const vorgaben = raetselAusVollemBrett(loesung, ziel, zufall);
  return { vorgaben, loesung, anzahlVorgaben: vorgaben.filter((w) => w !== 0).length };
}

/**
 * Erzeugt ein Rätsel der gewünschten Stufe. Kommt ein Versuch nicht nah genug
 * ans Ziel (manche volle Bretter lassen sich nicht so weit ausdünnen),
 * wird mit einem neuen vollen Brett wiederholt – höchstens MAX_VERSUCHE Mal.
 * Danach gilt der Versuch mit den wenigsten Vorgaben.
 * Gibt zusätzlich `versuche` zurück (zum Messen und Testen).
 */
export function erzeugeRaetsel(stufeKey, zufall = Math.random, maxVersuche = MAX_VERSUCHE) {
  const ziel = STUFEN[stufeKey].vorgaben;
  let bestes = null;
  let versuche = 0;
  while (versuche < maxVersuche) {
    versuche++;
    const kandidat = erzeugeRaetselVersuch(ziel, zufall);
    if (bestes === null || kandidat.anzahlVorgaben < bestes.anzahlVorgaben) bestes = kandidat;
    if (bestes.anzahlVorgaben <= ziel + TOLERANZ) break;
  }
  return { ...bestes, versuche };
}

/* ------------------------------------------------------------
   1e) Regelprüfung, Notizen, Speicher-Validierung
   ------------------------------------------------------------ */

/**
 * KONFLIKT-ANZEIGE: Markiert jedes Feld, dessen Ziffer in Zeile, Spalte
 * oder Block noch einmal vorkommt (Ergebnis: 81er-Liste mit 0/1).
 *
 * Wichtig: Das ist eine reine REGELPRÜFUNG. Sie kennt die Lösung nicht
 * und vergleicht nichts damit. Eine falsche Zahl, die zufällig noch zu
 * keiner anderen passt, ist KEIN Konflikt – sie fällt erst auf, wenn sie
 * später mit einer anderen Zahl kollidiert. Das ist der Unterschied zum
 * Schalter "Fehler sofort zeigen", der mit der Lösung vergleicht.
 */
export function konflikteBerechnen(werte) {
  const konflikt = new Uint8Array(81);
  for (let i = 0; i < 81; i++) {
    if (werte[i] === 0) continue;
    for (const nachbar of SICHTFELDER[i]) {
      if (werte[nachbar] === werte[i]) {
        konflikt[i] = 1; // beide Beteiligten werden markiert, weil
        break; // auch der Nachbar beim Durchlauf an die Reihe kommt
      }
    }
  }
  return konflikt;
}

/** Zählt, wie oft jede Ziffer auf dem Brett steht (Index 1–9; Index 0 zählt die leeren Felder). */
export function ziffernZaehlen(werte) {
  const zaehler = new Array(10).fill(0);
  for (const w of werte) zaehler[w]++;
  return zaehler;
}

/**
 * Wird eine echte Zahl gesetzt, entfernen wir deren Ziffer aus den Notizen
 * aller Felder in Zeile, Spalte und Block (= alle SICHTFELDER).
 *
 * WARUM? Eine Notiz sagt "diese Ziffer KÖNNTE hier stehen". Sobald die Ziffer
 * in einer Zeile, Spalte oder einem Block feststeht, kann sie in den
 * restlichen Feldern dieser Einheiten nicht mehr stehen – die Notizen
 * würden also etwas Falsches behaupten. Von Hand müsste man das nach jedem
 * Zug aufräumen, das ist mühsam und fehleranfällig. Das Spiel macht es
 * automatisch. Das ändert nur Notizen, nie echte Zahlen.
 */
export function notizenBereinigen(notizen, index, ziffer) {
  const bit = 1 << (ziffer - 1);
  for (const nachbar of SICHTFELDER[index]) notizen[nachbar] &= ~bit; // Bit löschen
}

/** Prüft, ob `liste` eine Liste aus `laenge` ganzen Zahlen zwischen min und max ist. */
function istZahlenliste(liste, laenge, min, max) {
  return (
    Array.isArray(liste) &&
    liste.length === laenge &&
    liste.every((n) => Number.isInteger(n) && n >= min && n <= max)
  );
}

/**
 * Prüft einen gespeicherten Spielstand, bevor wir ihm vertrauen.
 * localStorage kann von Hand verändert sein oder von einer älteren
 * Spielversion stammen. Statt blind zu laden, prüfen wir Form, Wertebereiche
 * und – ganz wichtig – lösen die Vorgaben NEU. Die Lösung speichern wir
 * absichtlich nicht mit: So kann ein manipulierter Spielstand keine falsche
 * Lösung einschleusen. Gibt ein bereinigtes Objekt zurück oder null.
 */
export function spielstandPruefen(daten) {
  if (!daten || typeof daten !== "object") return null;
  const { vorgaben, werte, notizen, ms } = daten;
  if (!istZahlenliste(vorgaben, 81, 0, 9)) return null;
  if (!istZahlenliste(werte, 81, 0, 9)) return null;
  if (!istZahlenliste(notizen, 81, 0, ALLE)) return null;

  for (let i = 0; i < 81; i++) {
    if (vorgaben[i] !== 0 && werte[i] !== vorgaben[i]) return null; // Vorgaben müssen unverändert sein
  }
  const ergebnis = suche(vorgaben, 2);
  if (ergebnis.anzahl !== 1) return null; // nur eindeutige Rätsel akzeptieren

  return {
    vorgaben: vorgaben.slice(),
    werte: werte.slice(),
    notizen: notizen.map((n, i) => (werte[i] !== 0 ? 0 : n)), // Felder mit Zahl brauchen keine Notizen
    loesung: ergebnis.loesung,
    ms: Number.isFinite(ms) ? Math.min(Math.max(0, ms), MAX_SEKUNDEN * 1000) : 0,
  };
}

/** Sekunden → "mm:ss", z. B. 75 → "01:15". */
export function zeitText(sekunden) {
  const mm = String(Math.floor(sekunden / 60)).padStart(2, "0");
  const ss = String(sekunden % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

/* ============================================================
   TEIL 2 · Spielzustand und DOM
   `z` ist der Zustand der aktuellen Runde und wird bei jedem neuen Spiel
   komplett neu angelegt. `el` sammelt die DOM-Elemente, die wir oft brauchen.
   ============================================================ */

let z = null; // Zustand der laufenden Runde
let stufeKey = "leicht"; // gewählte Stufe
let notizModus = false; // true = Ziffern werden als Notizen eingetragen
let fehlerSofort = false; // true = Eingaben werden mit der Lösung verglichen
let erzeugungsNr = 0; // zählt Erzeugungen hoch; veraltete Ergebnisse werden verworfen
const el = {}; // DOM-Elemente (werden in init() gefüllt)

/**
 * Zustand einer Runde. phase:
 *   "erzeuge"   – Rätsel wird gerade erzeugt, Eingaben gesperrt
 *   "laeuft"    – es wird gespielt
 *   "gewonnen"  – gelöst, Eingaben gesperrt
 */
function neuerZustand(phase, daten = null) {
  return {
    stufeKey,
    phase,
    vorgaben: daten ? daten.vorgaben : new Array(81).fill(0),
    loesung: daten ? daten.loesung : null,
    werte: daten ? daten.werte : new Array(81).fill(0), // aktuelle Ziffern (inkl. Vorgaben)
    notizen: daten ? daten.notizen : new Array(81).fill(0), // Bitmaske je Feld
    auswahl: 0, // Index des gewählten Feldes
    vergangenMs: daten ? daten.ms : 0, // Zeit aus abgeschlossenen Zeitabschnitten
    segmentStart: 0, // Beginn des laufenden Zeitabschnitts
    timerId: null,
    dialogTimerId: null,
    sekunden: 0,
  };
}

/** true, solange man Zahlen eintragen darf. */
function spielAktiv() {
  return z !== null && z.phase === "laeuft";
}

/** Räumt Uhr und verzögerte Dialoge der alten Runde weg und sichert den Stand. */
function spielAnhalten() {
  if (!z) return;
  timerPausieren();
  speichern();
  clearTimeout(z.dialogTimerId);
  z.dialogTimerId = null;
}

/** Kurz warten, damit der Browser "Erzeuge Rätsel…" überhaupt zeichnen kann, bevor wir rechnen. */
const kurzePause = () => new Promise((fertig) => setTimeout(fertig, 30));

/**
 * Neues Spiel in der gewählten Stufe.
 *
 * WARUM async + Pausen? JavaScript im Browser hat nur EINEN Faden: Solange
 * unsere Rechnung läuft, kann der Browser weder zeichnen noch Klicks
 * annehmen. Darum zeigen wir erst die Meldung, geben dem Browser Zeit zu
 * zeichnen (kurzePause) und rechnen dann. Jeder Generator-Versuch ist ein
 * eigenes "Häppchen": Dazwischen bekommt die Seite wieder Luft. Misslingt
 * der erste Versuch, friert so also nichts ein.
 */
async function neuesSpiel() {
  spielAnhalten();
  const meineNr = ++erzeugungsNr; // wer später kommt, macht frühere Aufträge ungültig
  z = neuerZustand("erzeuge");
  zeichne();
  statusSagen("Erzeuge Rätsel…");

  const ziel = STUFEN[stufeKey].vorgaben;
  let bestes = null;
  for (let versuch = 1; versuch <= MAX_VERSUCHE; versuch++) {
    await kurzePause();
    if (meineNr !== erzeugungsNr) return; // Nutzer hat inzwischen etwas anderes gewählt
    const kandidat = erzeugeRaetselVersuch(ziel);
    if (bestes === null || kandidat.anzahlVorgaben < bestes.anzahlVorgaben) bestes = kandidat;
    if (bestes.anzahlVorgaben <= ziel + TOLERANZ) break;
  }

  z = neuerZustand("laeuft", {
    vorgaben: bestes.vorgaben,
    loesung: bestes.loesung,
    werte: bestes.vorgaben.slice(),
    notizen: new Array(81).fill(0),
    ms: 0,
  });
  z.auswahl = Math.max(0, z.werte.indexOf(0)); // Start: erstes leeres Feld
  spielBereit();
  statusSagen(
    `Neues Rätsel, Stufe ${STUFEN[stufeKey].name}. ${z.werte.filter((w) => w === 0).length} leere Felder.`,
  );
}

/**
 * Beim Start oder Stufenwechsel: Gibt es für diese Stufe ein gespeichertes,
 * gültiges Spiel? Dann machen wir dort weiter, sonst wird ein neues erzeugt.
 */
function fortsetzenOderNeu() {
  spielAnhalten();
  erzeugungsNr++; // laufende Erzeugung (falls vorhanden) verwerfen
  const gespeichert = spielstandPruefen(lade(SPIEL, spielstandKey(stufeKey), null));
  if (!gespeichert) {
    neuesSpiel();
    return;
  }
  z = neuerZustand("laeuft", gespeichert);
  z.auswahl = Math.max(0, z.werte.indexOf(0));
  spielBereit();
  statusSagen("Gespeichertes Spiel fortgesetzt.");
}

/** Gemeinsamer Abschluss von "neu erzeugt" und "fortgesetzt". */
function spielBereit() {
  el.buehne.classList.remove("feier");
  if (!document.hidden) timerStarten(); // im verborgenen Tab startet die Uhr erst beim Zurückkommen
  zeichne();
  speichern();
}

/* ------------------------------------------------------------
   Uhr
   Wir addieren Zeitabschnitte: `vergangenMs` ist alles, was schon gelaufen
   ist, `segmentStart` der Beginn des aktuellen Abschnitts. Pausiert die Uhr
   (Tab verborgen), wird der laufende Abschnitt zu `vergangenMs` addiert.
   Gerechnet wird aus performance.now() statt "+1 pro Tick", weil Browser
   Intervalle in Hintergrund-Tabs drosseln.
   ------------------------------------------------------------ */
function aktuelleMs() {
  if (!z) return 0;
  return z.vergangenMs + (z.timerId !== null ? performance.now() - z.segmentStart : 0);
}

function timerStarten() {
  if (!z || z.timerId !== null) return;
  z.segmentStart = performance.now();
  z.timerId = setInterval(timerTick, 250); // 4× pro Sekunde, damit die Anzeige nie hängt
  timerTick();
}

function timerPausieren() {
  if (!z || z.timerId === null) return;
  z.vergangenMs += performance.now() - z.segmentStart;
  clearInterval(z.timerId);
  z.timerId = null;
}

function timerTick() {
  z.sekunden = Math.min(MAX_SEKUNDEN, Math.floor(aktuelleMs() / 1000));
  el.hudZeit.textContent = zeitText(z.sekunden);
}

/* ------------------------------------------------------------
   Speichern
   ------------------------------------------------------------ */

/** Sichert das laufende Spiel. Wird nach JEDER Eingabe aufgerufen. */
function speichern() {
  if (!spielAktiv()) return;
  // Die Lösung wird absichtlich nicht gespeichert (siehe spielstandPruefen).
  speichere(SPIEL, spielstandKey(z.stufeKey), {
    vorgaben: z.vorgaben,
    werte: z.werte,
    notizen: z.notizen,
    ms: Math.round(aktuelleMs()),
  });
}

/* ------------------------------------------------------------
   Rendering
   ------------------------------------------------------------ */

/** Baut einmalig die 81 Zellen. Danach werden sie nur noch aktualisiert, nie neu erzeugt. */
function brettBauen() {
  el.zellen = [];
  el.zahlen = [];
  el.minis = [];
  const sammler = document.createDocumentFragment(); // erst im Speicher bauen, dann EINMAL einfügen

  for (let i = 0; i < 81; i++) {
    const knopf = document.createElement("button");
    knopf.type = "button";
    knopf.className = "zelle";
    knopf.dataset.index = String(i);
    knopf.tabIndex = -1; // "Roving Tabindex": nur die gewählte Zelle hat 0 (siehe zeichne)
    // Dickere Linien nach Spalte 3 und 6 bzw. Zeile 3 und 6 trennen die 3×3-Blöcke.
    if (SPALTE[i] === 2 || SPALTE[i] === 5) knopf.classList.add("block-rechts");
    if (ZEILE[i] === 2 || ZEILE[i] === 5) knopf.classList.add("block-unten");

    const zahl = document.createElement("span"); // die große Ziffer
    zahl.className = "zahl";
    const notizen = document.createElement("span"); // das 3×3-Mini-Raster für Notizen
    notizen.className = "notizen";
    notizen.setAttribute("aria-hidden", "true"); // der Screenreader-Text steht im aria-label der Zelle
    const minis = [];
    for (let d = 1; d <= 9; d++) {
      const mini = document.createElement("i"); // Position d im Raster ist fest: 1 oben links … 9 unten rechts
      notizen.append(mini);
      minis.push(mini);
    }

    knopf.append(zahl, notizen);
    el.zellen.push(knopf);
    el.zahlen.push(zahl);
    el.minis.push(minis);
    sammler.append(knopf);
  }
  el.brett.replaceChildren(sammler);
}

/** Baut die Ziffernleiste 1–9 (der Radiergummi steht schon im HTML und bleibt am Ende). */
function ziffernleisteBauen() {
  el.ziffernKnoepfe = [];
  el.restAnzeigen = [];
  const radierer = document.getElementById("radierer");
  for (let d = 1; d <= 9; d++) {
    const knopf = document.createElement("button");
    knopf.type = "button";
    knopf.className = "ziffer";
    knopf.dataset.ziffer = String(d);
    const zahl = document.createElement("span");
    zahl.className = "ziffer-zahl";
    zahl.textContent = String(d);
    const rest = document.createElement("span"); // "so oft fehlt die Ziffer noch"
    rest.className = "rest";
    rest.setAttribute("aria-hidden", "true");
    knopf.append(zahl, rest);
    el.ziffern.insertBefore(knopf, radierer);
    el.ziffernKnoepfe.push(knopf);
    el.restAnzeigen.push(rest);
  }
}

/**
 * Zeichnet das gesamte Spiel aus dem Zustand `z`.
 * Es gibt nur diese eine Funktion, die Klassen und Texte setzt – so kann die
 * Anzeige nie von den Daten abweichen.
 */
function zeichne() {
  const laeuft = z.phase === "laeuft";
  const konflikte = konflikteBerechnen(z.werte);
  const sel = z.auswahl;
  const selWert = z.werte[sel];
  const bereich = new Set(SICHTFELDER[sel]); // Zeile, Spalte und Block der Auswahl

  for (let i = 0; i < 81; i++) {
    const zelle = el.zellen[i];
    const wert = z.werte[i];
    const istVorgabe = z.vorgaben[i] !== 0;
    // "Falsch" = Zahl weicht von der Lösung ab. Nur sichtbar mit dem Schalter.
    const istFalsch =
      fehlerSofort && z.loesung !== null && !istVorgabe && wert !== 0 && wert !== z.loesung[i];
    const hervorheben = z.phase !== "gewonnen"; // nach dem Sieg keine Auswahl-Hervorhebung mehr

    zelle.classList.toggle("vorgabe", istVorgabe);
    zelle.classList.toggle("auswahl", hervorheben && i === sel);
    zelle.classList.toggle("bereich", hervorheben && bereich.has(i));
    zelle.classList.toggle("gleich", hervorheben && selWert !== 0 && i !== sel && wert === selWert);
    zelle.classList.toggle("konflikt", konflikte[i] === 1);
    zelle.classList.toggle("falsch", istFalsch);
    zelle.tabIndex = i === sel ? 0 : -1;

    // textContent statt innerHTML: Werte gelangen nie als HTML ins Dokument.
    el.zahlen[i].textContent = wert === 0 ? "" : String(wert);

    // Notizen: Bit (d-1) gesetzt → Ziffer d im Mini-Raster anzeigen
    const notiz = wert === 0 ? z.notizen[i] : 0;
    const minis = el.minis[i];
    for (let d = 1; d <= 9; d++) {
      const hat = (notiz & (1 << (d - 1))) !== 0;
      minis[d - 1].textContent = hat ? String(d) : "";
      minis[d - 1].classList.toggle("treffer", hat && hervorheben && d === selWert);
    }

    zelle.setAttribute("aria-label", zellenBeschriftung(i, konflikte[i] === 1, istFalsch));
  }

  // Ziffernleiste: pro Ziffer anzeigen, wie oft sie noch fehlt (9 minus gesetzte)
  const zaehler = ziffernZaehlen(z.werte);
  for (let d = 1; d <= 9; d++) {
    const rest = Math.max(0, 9 - zaehler[d]);
    el.restAnzeigen[d - 1].textContent = String(rest);
    el.ziffernKnoepfe[d - 1].classList.toggle("fertig", rest === 0);
    el.ziffernKnoepfe[d - 1].setAttribute("aria-label", `Ziffer ${d}, noch ${rest} offen`);
    el.ziffernKnoepfe[d - 1].disabled = !laeuft;
  }
  el.radierer.disabled = !laeuft;

  el.erzeugung.hidden = z.phase !== "erzeuge";
  el.brett.setAttribute("aria-busy", String(z.phase === "erzeuge"));
  el.notizKnopf.setAttribute("aria-pressed", String(notizModus));
  el.buehne.classList.toggle("notizmodus", notizModus);
  hudZeichnen();
}

/** Screenreader-Text einer Zelle, z. B. "Zeile 3, Spalte 4: 5, Vorgabe". */
function zellenBeschriftung(i, imKonflikt, istFalsch) {
  const wert = z.werte[i];
  let text;
  if (wert !== 0) {
    text = z.vorgaben[i] !== 0 ? `${wert}, Vorgabe` : String(wert);
  } else {
    const notiz = ziffernAusMaske(z.notizen[i]);
    text = notiz.length > 0 ? `leer, Notizen ${notiz.join(", ")}` : "leer";
  }
  if (imKonflikt) text += ", Konflikt";
  if (istFalsch) text += ", falsch";
  return `Zeile ${ZEILE[i] + 1}, Spalte ${SPALTE[i] + 1}: ${text}`;
}

function hudZeichnen() {
  el.hudLeer.textContent = String(z.werte.filter((w) => w === 0).length);
  el.hudZeit.textContent = zeitText(z.sekunden);
  const beste = topliste(toplisteKey(stufeKey))[0];
  el.hudBest.textContent = beste ? zeitText(beste.punkte) : "--:--";
}

/** Zeigt die Topliste der aktuell gewählten Stufe (Punkte sind Sekunden → mm:ss). */
function toplisteAktualisieren() {
  toplisteAnzeigen(el.topliste, toplisteKey(stufeKey), zeitText);
  el.toplisteTitel.textContent = `Lokale Top 3 · ${STUFEN[stufeKey].name}`;
}

/** Meldung für Screenreader (sichtbar ist sie nicht). */
function statusSagen(text) {
  el.status.textContent = text;
}

/* ------------------------------------------------------------
   Spiellogik: Eingabe, Sieg
   ------------------------------------------------------------ */

/** Wählt ein Feld aus. `fokussieren` = zusätzlich den Tastaturfokus dorthin setzen. */
function waehle(index, fokussieren = false) {
  if (!z) return;
  z.auswahl = Math.max(0, Math.min(80, index));
  zeichne();
  if (fokussieren) el.zellen[z.auswahl].focus();
}

/** Ziffer d eintragen – als Zahl oder (im Notiz-Modus) als Notiz. */
function zifferEingeben(d) {
  if (!spielAktiv()) return;
  const i = z.auswahl;
  if (z.vorgaben[i] !== 0) return; // Vorgaben sind unveränderlich

  if (notizModus) {
    if (z.werte[i] !== 0) return; // Auf einem Feld mit Zahl gibt es keine Notizen
    z.notizen[i] ^= 1 << (d - 1); // XOR kippt genau dieses Bit: an ↔ aus
  } else if (z.werte[i] === d) {
    z.werte[i] = 0; // gleiche Ziffer nochmal = wieder löschen
  } else {
    z.werte[i] = d;
    z.notizen[i] = 0; // eigene Notizen sind jetzt überflüssig …
    notizenBereinigen(z.notizen, i, d); // … und die Ziffer fliegt aus den Notizen der Sichtfelder
  }
  nachAenderung();
}

/** Radiergummi: entfernt die Zahl, oder – wenn keine da ist – die Notizen des Feldes. */
function feldLeeren() {
  if (!spielAktiv()) return;
  const i = z.auswahl;
  if (z.vorgaben[i] !== 0) return;
  if (z.werte[i] !== 0) z.werte[i] = 0;
  else z.notizen[i] = 0;
  nachAenderung();
}

function notizModusUmschalten() {
  notizModus = !notizModus;
  if (z) zeichne();
}

/** Gemeinsamer Nachlauf jeder Änderung: neu zeichnen, speichern, Sieg prüfen. */
function nachAenderung() {
  zeichne();
  speichern();
  siegPruefen();
}

/**
 * Sieg = alle 81 Felder gefüllt UND keine Regelverletzung.
 * Eine Lösung mit vollem Brett ohne Konflikt MUSS die eindeutige Lösung
 * des Rätsels sein – ein Vergleich mit z.loesung ist darum nicht nötig
 * (und der Sieg hängt nicht vom Schalter "Fehler sofort zeigen" ab).
 */
function siegPruefen() {
  if (z.werte.includes(0)) return;
  if (konflikteBerechnen(z.werte).includes(1)) return;
  gewonnen();
}

function gewonnen() {
  z.phase = "gewonnen";
  timerPausieren();
  z.sekunden = Math.max(1, Math.min(MAX_SEKUNDEN, Math.floor(z.vergangenMs / 1000))); // mindestens 1 s
  entferne(SPIEL, spielstandKey(z.stufeKey)); // Ein gelöstes Spiel soll nicht beim Neuladen wiederkommen
  zeichne();
  statusSagen(`Gelöst in ${zeitText(z.sekunden)}.`);

  // Feier-Welle: Jede Zelle pulst, verzögert nach Abstand zum zuletzt gesetzten Feld.
  // Das CSS liest die Verzögerung aus --v (wie beim Minesweeper).
  const reduziert = bewegungReduziert();
  const ox = SPALTE[z.auswahl],
    oy = ZEILE[z.auswahl];
  for (let i = 0; i < 81; i++) {
    const abstand = Math.hypot(SPALTE[i] - ox, ZEILE[i] - oy); // Luftlinie → kreisförmige Welle
    el.zellen[i].style.setProperty(
      "--v",
      reduziert ? "0ms" : `${Math.round(abstand * FEIER_MS_PRO_FELD)}ms`,
    );
  }
  el.buehne.classList.add("feier");

  const sekunden = z.sekunden;
  const stufe = z.stufeKey;
  z.dialogTimerId = setTimeout(
    () => {
      const dialog = gameOverDialog({
        spiel: toplisteKey(stufe),
        titel: "GELÖST!",
        punkte: sekunden,
        punkteText: zeitText(sekunden),
        richtung: "runter", // kürzere Zeit = besser
        format: zeitText, // Topliste im Dialog als mm:ss anzeigen
        neustart: neuesSpiel,
      });
      // Endet der Dialog (Knopf oder Esc), zeigen Seite und HUD die neue Topliste
      beiDialogEnde(dialog, () => {
        toplisteAktualisieren();
        hudZeichnen();
      });
    },
    reduziert ? 400 : FEIER_DIALOG_MS,
  );
}

/**
 * Führt `aktion` aus, sobald ein Dialog endet. Zwei Ereignisse sind nötig:
 * "close" (Dialog wurde geschlossen) und "cancel" (Esc gedrückt) – siehe
 * Minesweeper. `aktion` muss deshalb harmlos mehrfach laufen können.
 */
function beiDialogEnde(dialog, aktion) {
  dialog.addEventListener("close", aktion);
  dialog.addEventListener("cancel", aktion);
}

/* ============================================================
   TEIL 3 · Eingabe
   ============================================================ */

/** Findet zur Ereignis-Quelle die Zelle und gibt deren Index zurück (oder -1). */
function indexAus(ereignisZiel) {
  const zelle = ereignisZiel.closest?.(".zelle");
  return zelle ? Number(zelle.dataset.index) : -1;
}

/** Ein Klick auf einen Knopf, der erst beim zweiten Klick wirklich etwas tut (gegen Fehlklicks). */
function zweiStufig(knopf, frage, brauchtBestaetigung, aktion) {
  const normalText = knopf.textContent;
  let timer = null;
  knopf.addEventListener("click", () => {
    if (timer === null && brauchtBestaetigung()) {
      knopf.textContent = frage; // erster Klick: nachfragen
      knopf.classList.add("warnung");
      timer = setTimeout(zuruecksetzen, 3500); // nach 3,5 s zurück in den Normalzustand
      return;
    }
    zuruecksetzen();
    aktion(); // zweiter Klick (oder nichts zu verlieren): ausführen
  });
  function zuruecksetzen() {
    clearTimeout(timer);
    timer = null;
    knopf.textContent = normalText;
    knopf.classList.remove("warnung");
  }
}

/** Hat die Spielerin schon etwas eingetragen, das bei "Neues Spiel" verloren ginge? */
function fortschrittVorhanden() {
  return (
    spielAktiv() && (z.werte.some((w, i) => w !== z.vorgaben[i]) || z.notizen.some((n) => n !== 0))
  );
}

function eingabeEinrichten() {
  /* --- Maus und Touch: Klick/Tipp wählt ein Feld (Event Delegation:
     EIN Listener am Brett statt 81 an den Zellen). */
  el.brett.addEventListener("click", (e) => {
    const index = indexAus(e.target);
    if (index >= 0) waehle(index);
  });

  /* --- Ziffernleiste (Touch!): setzt die Ziffer im gewählten Feld. */
  el.ziffern.addEventListener("click", (e) => {
    const knopf = e.target.closest("button");
    if (!knopf) return;
    if (knopf.id === "radierer") feldLeeren();
    else zifferEingeben(Number(knopf.dataset.ziffer));
  });
  // Maus-Druck auf die Leiste soll den Fokus NICHT von der Zelle nehmen,
  // damit man danach direkt mit den Pfeiltasten weiterspielen kann.
  el.ziffern.addEventListener("mousedown", (e) => e.preventDefault());

  el.notizKnopf.addEventListener("click", notizModusUmschalten);

  /* --- Tastatur. Ein Listener am ganzen Dokument, damit Ziffern auch dann
     funktionieren, wenn der Fokus gerade auf einem Knopf (z. B. in der
     Ziffernleiste) liegt. Wir müssen deshalb selbst aufpassen, wann wir
     NICHT eingreifen dürfen. */
  document.addEventListener("keydown", (e) => {
    if (!z) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return; // Browser-Kürzel nicht stören
    if (document.querySelector("dialog[open]")) return; // im Dialog tippt man Initialen
    if (e.target.closest?.("input, textarea, select, [contenteditable]")) return;

    if (e.key >= "1" && e.key <= "9") {
      e.preventDefault();
      zifferEingeben(Number(e.key));
    } else if (e.key === "0" || e.key === "Backspace" || e.key === "Delete") {
      e.preventDefault();
      feldLeeren();
    } else if (e.key === "n" || e.key === "N") {
      notizModusUmschalten();
    } else if (e.key.startsWith("Arrow") && e.target.closest?.(".buehne")) {
      // Pfeile nur innerhalb des Spielbereichs, sonst würde man das Scrollen der Seite blockieren.
      e.preventDefault();
      let x = SPALTE[z.auswahl];
      let y = ZEILE[z.auswahl];
      if (e.key === "ArrowLeft") x--;
      else if (e.key === "ArrowRight") x++;
      else if (e.key === "ArrowUp") y--;
      else if (e.key === "ArrowDown") y++;
      x = Math.max(0, Math.min(8, x)); // am Rand stehen bleiben
      y = Math.max(0, Math.min(8, y));
      waehle(y * 9 + x, true);
    }
  });

  /* --- Tab verborgen → Uhr anhalten (und Stand sichern), zurück → weiter. */
  document.addEventListener("visibilitychange", () => {
    if (!spielAktiv()) return;
    if (document.hidden) {
      timerPausieren();
      speichern();
    } else {
      timerStarten();
    }
  });
  // Schließt man den Tab, sichert dieses Ereignis noch die letzte Zeit.
  window.addEventListener("pagehide", speichern);
}

/* ============================================================
   TEIL 4 · Start
   ============================================================ */

/** Markiert den Stufen-Knopf der gewählten Stufe (aria-pressed). */
function stufenKnoepfeAktualisieren() {
  for (const knopf of document.querySelectorAll(".stufen-leiste [data-stufe]")) {
    knopf.setAttribute("aria-pressed", String(knopf.dataset.stufe === stufeKey));
  }
}

function stufeWaehlen(neueStufe) {
  if (!STUFEN[neueStufe] || neueStufe === stufeKey) return;
  spielAnhalten(); // Stand der alten Stufe sichern – sie bleibt erhalten
  stufeKey = neueStufe;
  speichere(SPIEL, "stufe", stufeKey); // beim nächsten Besuch wieder da
  stufenKnoepfeAktualisieren();
  toplisteAktualisieren();
  fortsetzenOderNeu();
}

function init() {
  el.buehne = document.querySelector(".buehne");
  el.brett = document.getElementById("brett");
  el.erzeugung = document.getElementById("erzeugung");
  el.ziffern = document.getElementById("ziffern");
  el.radierer = document.getElementById("radierer");
  el.notizKnopf = document.getElementById("notiz-modus");
  el.fehlerSchalter = document.getElementById("fehler-sofort");
  el.hudLeer = document.getElementById("hud-leer");
  el.hudZeit = document.getElementById("hud-zeit");
  el.hudBest = document.getElementById("hud-best");
  el.topliste = document.getElementById("topliste");
  el.toplisteTitel = document.getElementById("topliste-titel");
  el.status = document.getElementById("status");

  // Gespeicherte Einstellungen laden; unbekannte Werte (z. B. von Hand verändert) ignorieren
  const gemerkt = lade(SPIEL, "stufe", "leicht");
  stufeKey = STUFEN[gemerkt] ? gemerkt : "leicht";
  fehlerSofort = lade(SPIEL, "fehlerSofort", false) === true;
  el.fehlerSchalter.checked = fehlerSofort;
  stufenKnoepfeAktualisieren();

  brettBauen();
  ziffernleisteBauen();
  eingabeEinrichten();

  for (const knopf of document.querySelectorAll(".stufen-leiste [data-stufe]")) {
    knopf.addEventListener("click", () => stufeWaehlen(knopf.dataset.stufe));
  }

  el.fehlerSchalter.addEventListener("change", () => {
    fehlerSofort = el.fehlerSchalter.checked;
    speichere(SPIEL, "fehlerSofort", fehlerSofort);
    if (z) zeichne();
  });

  // "Neues Spiel" fragt nach, wenn schon etwas eingetragen wurde.
  zweiStufig(
    document.getElementById("neues-spiel"),
    "Wirklich neu?",
    fortschrittVorhanden,
    neuesSpiel,
  );

  // Reset: alle drei Toplisten UND die gespeicherten Spiele löschen, dann frisch starten.
  // Die Einstellungen (Stufe, Fehler-Schalter) bleiben erhalten.
  zweiStufig(
    document.getElementById("reset"),
    "Wirklich löschen?",
    () => true,
    () => {
      spielAnhalten();
      z.phase = "erzeuge"; // sperrt speichern(): Das laufende Spiel darf sich nicht selbst neu abspeichern
      for (const key of Object.keys(STUFEN)) {
        spielZuruecksetzen(toplisteKey(key));
        entferne(SPIEL, spielstandKey(key));
      }
      toplisteAktualisieren();
      neuesSpiel();
    },
  );

  toplisteAktualisieren();
  fortsetzenOderNeu();
}

// In Node (Tests) gibt es kein `document` – dort wollen wir nur die reinen
// Funktionen oben importieren und das Spiel NICHT starten.
if (typeof document !== "undefined") init();
