# Plan: Prototyp in die echte App übernehmen

Stand 19.10.2026 · Mit dir durchgegangen; die Entscheidungen stehen am Ende.

## Ausgangslage

Die echte App hat die meisten Machines-&-Jobs-Screens schon, auch Wizard, Connectors, Diagnostics und Inventory. Die Lücken liegen woanders:

- **Sales-Redesign:** Übersicht, Orders mit Tabs und Filtern, Freigabe-Ablauf für Rechnungen, Kassabuch mit Bargeld-Bewegungen, rollenbasierte Preise.
- **Mass Edit in Jobs.**
- **Die neuen UI-Bausteine:** Filter-Panel, Tabellen-Switcher, verlinkte Referenzen.
- **Die neuen Wünsche von heute:** Directory mit Organizations, Preise pro Filamentart, andere Maschinenarten, Farben aufräumen.

Der Kern des Logbuchs ist schon allgemein gehalten: Maschinentypen, Runs, Jobs, Material-Verbrauch mit Einheit und Laufzeitpreis pro Maschinentyp. FDM-spezifisch sind dagegen fünf Dinge:

- Spulen und Füllungen, die nur mit Gramm und Durchmesser funktionieren.
- Die `printer_*`-Tabellen.
- Connector-Events in Gramm.
- `reported_quantity_g` am Run.
- Der Schalter `printer` am Maschinentyp.

Alles davon bleibt erhalten und wird zu **einem** Prozess unter mehreren.

---

## Teil A: Directory und Organizations

**Navigation:** Die Gruppe „People“ heißt künftig **Directory**. Darunter stehen **People** (bisher „Directory“, `/people`), **Organizations** (neu, `/organizations`) und **Staffing** (unverändert).

**Organizations-Seite.** Die Liste hat Suche und das neue Filter-Panel mit den Filtern Art, aktiv und Preisgruppe. Die Detailseite hat drei Bereiche:
- **Stammdaten:** Name und Art (Firma, Institut, Verein, Sonstiges).
- **Rechnungsdaten:** Rechnungsadresse, Kontaktperson und „Bestellnummer erforderlich“. Diese Daten sind heute in `organization_invoicing_requirements` und werden in die Organisation integriert.
- **Verknüpfungen:** Preisgruppe, Jobs und Orders der Organisation.

**Verwaltung:** Anlegen und Bearbeiten ziehen aus *Settings › Machine logbook* hierher um. Dort verschwindet der Organisationen-Teil.

**Backend:**
- Organisationen bekommen Adressfelder und eine Kontaktperson. Damit lässt sich ein Rechnungsentwurf vorbefüllen.
- Die Berechtigungen bleiben `organizations.read` und `organizations.manage`.

---

## Teil B: Farben, Materialarten und Preise pro Filamentart

### Heutiges Problem

Farbe taucht an mehreren Stellen auf:
- **Am Material:** Freitext „Colour“, oft zusätzlich schon im Namen.
- **In der Druckdatei:** Farbe der geplanten Filamente.
- **Live aus dem AMS:** die Fachfarbe als Farbcode.
- **Indirekt an Spulen:** über das Material.

Unklar ist, welche davon „die“ Farbe ist.

Preise hängen heute an *Kategorie + Einheit*, die Kategorie ist Freitext. Pro Filamentart (PLA, PETG, TPU, PETG-CF …) lässt sich so kein sauberer Preis setzen.

### Neues Modell

**Materialart** (neu, eine eigene Liste). Beispiele: PLA, PETG, TPU 95A, PETG-CF, Stickgarn, Stickvlies (Tear-away), UV-Tinte, DTF-Stickerpapier, Roll-to-Film, Plotterfolie, Sperrholz 3 mm, Acryl 3 mm.
- **Felder:** Name, Prozess(e), Verrechnungseinheit und bei Filament der Durchmesser.
- **Rolle:** Die Materialart ist **die Ebene, an der der Preis hängt**.

**Material** (bestehend) wird zur **Variante einer Materialart**. Felder: Hersteller und Produkt, **Farbe** und Lagerbestand.
- Die Farbe besteht aus einem Namen und einem Farbcode. Den Farbcode wählt man mit einem Farbfeld, die Vorschau ist ein Farbpunkt.
- **Die Farbe wird nur hier erfasst.**

**Spulen, Jobs und Runs:** Sie zeigen die Farbe des Materials nur an und erfassen sie nicht selbst.

**Erkannte Farben aus Datei und AMS:** Sie werden klar als „erkannt“ gekennzeichnet und nur zum Abgleich genutzt.
- Passt die gemountete Spule farblich nicht zum Fach, erscheint ein Hinweis.
- Kennt die App die Farbe noch nicht, kann man sie beim Anlegen des Materials übernehmen („Farbe aus AMS übernehmen“).

**Preisregeln:**
- Material wird künftig **pro Materialart** abgerechnet, zum Beispiel PLA 0,04 €/g, PETG 0,05 €/g, TPU 0,08 €/g.
- Die bisherigen Kategorie-Regeln werden per Migration in Materialarten übernommen. Bestehende Preise bleiben also gleich.

**Migration:** Aus den bisherigen Kategorien entstehen Materialarten. Farbtexte, die im Namen und im Farbfeld doppelt stehen, bleiben als Text stehen. Den Farbcode kann man später nachtragen.

---

## Teil C: Andere Maschinen genauso elegant wie FDM

### Prinzip: Prozess pro Maschinentyp

Der Maschinentyp bekommt statt `printer: true/false` einen **Prozess**. Er legt fest, was ein Run erfasst und was verrechnet wird.

| Prozess | Beispiel | Laufzeit | Run-Messwerte | Material (Einheit) |
|---|---|---|---|---|
| FDM-3D-Druck | Bambu H2D, Prusa | ✓ €/h | – | Filament pro Materialart (g), über Spulen |
| Sticken | Stickmaschine | ✓ €/h | **Stichanzahl** (€ pro 1000 Stiche) | Stickvlies (Laufmeter), Garn optional |
| UV-Druck | eufy Make | ✓ €/h | – | UV-Tinte (ml), DTF-Stickerpapier (cm²), Roll-to-Film (Laufmeter) |
| Laserschneiden | Lasercutter | ✓ €/h (Hauptsache) | – | Plattenmaterial (cm²), oft Kundenmaterial |
| Schneideplotter | Plotter | ✓ €/h oder 0 | – | Folie (cm²) |
| Sonstiges | – | ✓ | – | frei |

**Laufzeit gibt es überall.** Der Lasercutter funktioniert damit vor allem als Zeiterfassung, wie gewünscht.

### Was dafür neu gebaut wird

1. **Maschinentyp-Prozess:** Das Feld `process` ersetzt `printer`. Die Migration macht aus `printer = true` den Prozess FDM.
   - Der Drucker-Setup, der Wizard, die Connectors und die Spulen-Eingänge hängen künftig an „Prozess = FDM“.
   - Für FDM ändert sich nichts.
2. **Run-Messwerte:** eine kleine Tabelle `machine_run_measures` mit Run, Messwert-Schlüssel und Wert.
   - Am Anfang gibt es nur `stitches`. Das Modell ist offen für weitere, z. B. Farbwechsel.
   - Die Stichanzahl wird **genau auf den Stich** erfasst, als ganze Zahl.
   - Der Preis wird pro Block definiert, z. B. 0,50 € pro 1000 Stiche. Die App rechnet anteilig: 12.400 Stiche ergeben 6,20 €.
3. **Einheiten:** neu ist **cm²**.
   - Laufmeter (`m`) und ml gibt es schon.
   - m² bleibt für bestehende Daten erhalten, angezeigt wird es einheitlich.
   - Preise pro cm² werden mit genug Nachkommastellen gespeichert.
4. **Flächen-Eingabe:** Bei cm²-Material gibt man im Verbrauch **Breite × Höhe × Anzahl** ein, die Fläche rechnet die App aus. Laufmeter gibt man direkt ein.
5. **Run-Formular nach Prozess:**
   - **FDM wie heute:** Spulen, Gramm, Druckdatei, Connector.
   - **Sticken:** Laufzeit, Stichanzahl, Vlies in Laufmetern.
   - **UV-Druck:** Laufzeit, Tinte in ml, Trägermaterial in cm² oder Laufmetern.
   - **Laser:** Laufzeit und optional Material in cm²; Kundenmaterial bleibt gratis.
   - **Plotter:** Folie in cm².

   Die Felder kommen aus einer gemeinsamen Prozess-Konfiguration. Es entstehen keine fünf eigenen Formulare.

   **Materialauswahl nach Prozess:** Jede Materialart legt fest, für welche Prozesse sie verwendbar ist. Beispiele:
   - PLA → FDM.
   - Stickvlies → Sticken.
   - Plotterfolie → Plotter.
   - Acryl → Laser und UV-Druck.

   Beim manuellen Anlegen eines Runs zeigt die Materialauswahl **nur Materialien, die zum Prozess der Maschine passen**. Kundenmaterial bleibt als Freitext immer möglich.

   Ältere Runs mit einem Material, das nicht mehr passt, zeigen dieses Material weiter an. Die Einschränkung gilt nur für neue Auswahlen.
6. **Lagerbestand für Rollen- und Plattenware:** Bestand in Laufmetern bzw. cm².
   - Zubuchen und Verbrauch laufen über das bestehende Ledger.
   - Spulen-Logik gibt es weiterhin nur für Filament.
7. **Jobs-Tabelle und Run-Detail:** Statt „Gramm“ zeigen sie eine **Verbrauchszusammenfassung** in der jeweiligen Einheit, z. B. „12.400 Stiche · 0,4 m Vlies“ oder „3,2 ml Tinte · 180 cm²“.
8. **Statistik:** Laufzeit pro Maschine gibt es schon. Neu kommen Verbrauch und Kosten pro Materialart dazu.

### Was bewusst nicht gemacht wird

- **Keine Connectoren** für Stickmaschine, eufy, Laser oder Plotter. Diese Runs werden manuell erfasst. Ein Connector lässt sich später für einen einzelnen Prozess ergänzen.
- **Kein Datei-Parsing** für Stick-, Druck- oder Schneidedateien.

---

## Teil D: Prototyp-Funktionen übernehmen

### D1: Gemeinsame UI-Bausteine

- Filter-Panel nach Carbon-„Batch-Filter“.
- Tabellen-Switcher in der Toolbar.
- Verlinkte J-/R-/O-/P-Referenzen.
- Hinweisboxen mit Links.

Diese Bausteine werden auf alle Tabellen der App umgestellt: Jobs, Machines, Inventory, Orders, Payments, People und Organizations.

### D2: Jobs-Mass-Edit

- Mehrfachauswahl mit diesen Aktionen: löschen, einzelne Jobs erstellen, einen gemeinsamen Job erstellen und an einen Job hängen.
- **Backend:** Bulk-Endpunkte, die atomar in **einer** Transaktion mit Audit laufen.
- Die bestehenden Regeln für das Löschen gelten weiter: Material zurückbuchen oder behalten, Runs mitlöschen oder nicht.

### D3: Sales-Backend

1. **Counter Sales entfernen:** Endpunkt, Seite und Navigation fallen weg. Jeder Run braucht einen Job und damit einen Kunden.
2. **Rechnungs-Freigabe:**
   - Die Zustände sind Draft → Awaiting approval → Issued; der Schritt „ready“ entfällt.
   - Neue Berechtigung `external_invoice_requests.approve`.
   - „Zur Korrektur zurückgeben“ verlangt einen Kommentar.
   - „An wiRef weitergeleitet“ stellt die Rechnung aus. Die Rechnungsnummer ist optional und lässt sich nachtragen.
3. **Ausgestellte Rechnung gilt als gezahlt:**
   - Das Ausstellen bucht eine Zahlung „Invoice (wiRef)“ über den offenen Betrag, und die Order ist bezahlt.
   - Keine Erfassung von Banküberweisungen.
   - Eine Rechnung ist auch möglich, wenn schon bar oder mit Karte teilbezahlt wurde. Dafür fällt die heutige Sperre weg.
4. **Bargeld-Bewegungen:** Entnahmen und Einlagen mit Grund und Notiz.
   - Der erwartete Kassenstand zählt **nur Bargeld**.
   - Neue Berechtigungen fürs Lesen und Erfassen.
5. **Rollenbasierte Preise:**
   - Kontorollen werden auf Preisgruppen gemappt, mit einer Priorität. Organisationen haben eine eigene Gruppe.
   - Die Reihenfolge der Preisauflösung: Gruppe am Job → Organisation → Rolle → Standard.
6. **`createdBy` und `recordedBy`:** Anzeigenamen an Orders und Zahlungen.

### D4: Sales-Frontend

- **Übersicht** mit Kacheln: Kassenstand, Einnahmen, offen, Rechnungen zur Freigabe, abrechenbare Jobs. Dazu eine Liste „Needs attention“.
- **Orders:** Tabs Open · Paid · Cancelled, Filter-Panel mit Rechnungs- und Kundenfiltern, „Review jobs (N)“.
- **Order-Detail:**
  - Rechnung direkt im Zahlungsdialog.
  - Payments-Liste mit Hinweisen in der Tabelle.
  - Rechnungsbereich mit Freigabe-Ablauf und „Copy for wiRef“.
- **Payments:**
  - Kassabuch mit dem Zeitraum im Filter-Panel und Kacheln.
  - Bargeld-Entnahme und -Einlage.
  - CSV-Export mit Semikolons, Dezimalkomma und UTF-8 mit BOM. Er entsteht im Client, solange kein Server-Export nötig ist.
- **Pricing-Seite:**
  - Preise pro Materialart und Maschinentyp, Messwert-Preise, Rollen-Mapping, Vorschau.
  - Die Preisverwaltung wandert aus Settings hierher.

### D5: Noch offen aus dem Prototyp (als „Proposed“ markiert)

Diese Punkte übernehme ich nur, wenn du das willst:
- Order-Zeitleiste.
- Belegnummern und Beleg als PDF.
- Fixpreis-Artikel, also ein Katalog für Dinge ohne Job.

---

## Reihenfolge (jede Phase einzeln committet und testbar)

1. **A:** Directory und Organizations. Klein, sofort nützlich, und Voraussetzung für Rechnungsdaten.
2. **D1:** UI-Bausteine. Alles Spätere baut darauf auf.
3. **B:** Materialarten, Farben und Preise pro Materialart. Das ist die Grundlage für C und für die Pricing-Seite.
4. **C:** Prozesse, Messwerte, cm² und das prozessabhängige Run-Formular.
5. **D2:** Jobs-Mass-Edit.
6. **D3:** Sales-Backend, Schritte 1 bis 6.
7. **D4:** Sales-Frontend.
8. **D5:** nur nach deiner Entscheidung.

Für jede Phase gilt:
- Zuerst kommen die OpenAPI-Spezifikation, Migration, Service-Regeln, Berechtigungen mit Tests und Integrationstests gegen `makerspace_test`. Danach das Frontend.
- Danach laufen Build und Bundle-Budget sowie eine Prüfung im Browser auf Desktop und schmal.

## Entscheidungen (19.10.2026)

1. **Preise:** nur pro Materialart. Varianten wie Silk-PLA werden eigene Materialarten.
2. **Sticken:** Die Maschine liefert nur die Stichanzahl. Die Stiche werden genau erfasst, der Preis pro 1000 Stiche. Es gibt keinen Garnbestand, der an die Stiche gekoppelt ist.
3. **UV-Tinte:** Die eufy-Software meldet den Verbrauch in ml mit zwei Nachkommastellen, **pro Tinte (C, M, Y, K, W)**.
   - Jede Tinte ist ein eigenes Material der Materialart „UV-Tinte“, mit ihrer Farbe.
   - Das Run-Formular für UV-Druck zeigt dafür fünf ml-Felder, eines pro Tinte.
   - Hat eine Tinte einen anderen Preis, wird sie eine eigene Materialart, z. B. „UV-Tinte Weiß“.
4. **DTF-Stickerpapier:** wird nach cm² abgerechnet.
5. **Zeit:** Jede Maschine kann Laufzeit verrechnen. Soll eine Gruppe keine Zeit zahlen, bekommt sie 0 €/h.
6. **Counter Sales:** werden in der echten App ganz entfernt.
7. **Preisgruppe:**
   - Die Preisgruppe lässt sich **am Job manuell überschreiben**.
   - Die **Preisanpassungen am Job** bleiben, wie sie sind.
   - Sonst gilt: Organisation → Rolle → Standard.
   - Die heutige Zuordnung pro Person entfällt; das ersetzen Rollen-Mapping und Überschreiben am Job.
8. **Organisationen:** Organisationen haben **zugeordnete Personen**.
   - Bestellen darf trotzdem jeder für jede Organisation.
   - Die Zuordnung dient der Übersicht und schlägt die Organisation beim Anlegen eines Jobs vor.
9. **Reihenfolge:** wie oben.
