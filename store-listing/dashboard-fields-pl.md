# Lil Bro Wipe – History Cleaner, pola w panelu (wersja polska)

Do wklejenia w panelu, w zakładce języka polskiego. Limity znaków podane przy każdym polu.

## Pola z pakietu (tylko do odczytu)

- Tytuł: `Lil Bro Wipe – History Cleaner`
- Podsumowanie: `Czyści z historii wybrane strony i słowa: w trakcie przeglądania albo przy następnym otwarciu przeglądarki.`

Oba pola panel bierze z wgranego pakietu, więc stare brzmienie zostanie tam do momentu wgrania nowego pakietu. Stare zdanie obiecywało też czyszczenie przy zamykaniu przeglądarki, a tego w aplikacji
już nie ma.

## Opis (16000)

```
Lil Bro usuwa z historii przeglądania to, czego nie chcesz tam trzymać. Dajesz mu listę i on zajmuje się wszystkim: stroną, słowem, początkiem adresu. Sklep, wątek na forum, nazwisko wpisane raz.

Dodanie zajmuje chwilę: kliknij ikonę na pasku i dodaj stronę, na której jesteś, albo kliknij prawym przyciskiem myszy i wybierz ją z menu. Na start nie ma nic do ustawiania.

Decydujesz, kiedy ma działać: może czyścić w trakcie przeglądania – wtedy wpis znika, gdy strona się ładuje. Może czekać do następnego uruchomienia – wtedy wizyta zostaje, dopóki nie zamkniesz laptopa. A gdy dodajesz coś nowego, przełącznik „starsze wizyty też” pod polem dodawania (domyślnie włączony) zabiera je z historii od razu i mówi, ile ich było.

Historia to główna rzecz, ale poza nią może czyścić też pamięć podręczną, ciasteczka, pobrane pliki i tekst wpisany w formularze. Wszystko to jest domyślnie wyłączone. Jedna uwaga: ciasteczka znikają z całej strony, więc wylogujesz się z niej. Twoja lista zachowanych stron zostaje nietknięta.

Wszystko dzieje się na twoim komputerze: bez konta, serwera i analityki, sam nie wysyła ani nie pobiera niczego. Historia czyszczenia zostaje u ciebie i możesz ją wyczyścić w każdej chwili. Na listę możesz też założyć PIN, żeby nikt inny przy tym komputerze jej nie przeczytał.

Żeby nic cię nie zaskoczyło: haseł nie rusza, bo przeglądarka na to rozszerzeniom nie pozwala. Czyszczenie przy zamknięciu przeglądarki nie włączy się w dokładnej sekundzie zamknięcia – zrobi to przy następnym otwarciu. A pobrane pliki i tekst z formularzy czyści dla wybranego zakresu czasu – nie dla pojedynczych stron.
```

Każdy akapit to jedna linia, więc wklejenie do panelu daje czyste akapity, a nie zdania łamane w miejscu, w którym łamie się ten plik.

## Kategoria

Prywatność i bezpieczeństwo. Ustawione.

## Zasoby graficzne

Folder `graphics` jest podzielony tak samo jak panel: `all-languages`, `en`, `pl`.

- Ikona sklepu 128x128: `graphics/icons/icon128.png`
- Mały obraz promocji 440x280: `graphics/pl/promo-440x280.png`
- Transparent promocyjny 1400x560: `graphics/pl/marquee-1400x560.png`
- Zrzuty ekranu, pięć, każdy dokładnie 1280x800, 24-bitowy PNG bez kanału alfa, z wersji
  folder `screenshots/pl/` (`01-options-1280x800.png`, `02-list-and-log-1280x800.png`,
  `03-locked-1280x800.png`, `04-popup-1280x800.png`, `05-look-and-language-1280x800.png`).
  Te pięć jest po polsku, więc idą w
  sekcji zlokalizowanej dla polskiego, nie w „wszystkie języki".

## Film promocyjny

Puste. Nie ma filmu.

## Adresy

- Strona główna: `https://forsigh.github.io/lil-bro-history-wipe/`
- Strona produktu: ten sam adres
- Adres URL pomocy: `https://github.com/Forsigh/lil-bro-history-wipe/issues`
- Polityka prywatności: `https://forsigh.github.io/lil-bro-history-wipe/privacy.html`

Adres pomocy prowadzi w to samo miejsce, do którego odsyła polityka prywatności („zgłoś
problem na GitHubie"), więc oba pola się zgadzają.

## Treści dla dorosłych

Nie.

## Dodatkowe dane (GA4)

Nic. W pakiecie nie ma kodu analitycznego.

## Jedno przeznaczenie (1000)

```
Usuwa z historii przeglądania wpisy, które wybierze użytkownik. Użytkownik wpisuje na listę
strony, subdomeny, słowa, początki adresów albo wzory; rozszerzenie dopasowuje je do historii i
usuwa pasujące wpisy, w trakcie przeglądania albo przy następnym otwarciu przeglądarki. Po
włączeniu dodatkowych przełączników może też czyścić cache, cookies, listę pobranych plików i
tekst z formularzy dla tej samej listy. Nie robi nic więcej.
```

Obecny tekst mówi o czyszczeniu „przy zamknięciu przeglądarki", którego już nie ma, i pomija
dodatkowe rodzaje danych, dla których istnieją cztery z tych uprawnień. Jedno i drugie jest
naprawione powyżej.

## Uzasadnienia uprawnień

history (1000)
```
Potrzebne, żeby odczytać historię przeglądania i znaleźć wpisy pasujące do reguł wpisanych
przez użytkownika, a potem usunąć tylko te wpisy. To cała funkcja rozszerzenia. Historia jest
przetwarzana na urządzeniu, nigdzie nie jest wysyłana i nie jest czytana w żadnym innym celu.
```

storage (1000)
```
Przechowuje reguły użytkownika, jego ustawienia, opcjonalny lokalny zapis tego, co zostało
wyczyszczone, oraz PIN, jeśli użytkownik go ustawi. Wszystko zostaje na urządzeniu
użytkownika i nic nie jest wysyłane. Reguły można wyeksportować, a zapis wyczyścić w każdej
chwili.
```

notifications (1000)
```
Pokazuje jedno, opcjonalne powiadomienie po czyszczeniu, z liczbą usuniętych wpisów.
Użytkownik może je wyłączyć w ustawieniach; przy wyłączonym nic się nie pokazuje.
```

contextMenus (1000)
```
Dodaje dwie pozycje w menu po prawej stronie, żeby użytkownik mógł dopisać bieżącą stronę albo
całą witrynę do swojej listy bez wchodzenia w ustawienia.
```

activeTab (1000)
```
Używane tylko po kliknięciu przycisku rozszerzenia na pasku. Małe okienko odczytuje adres
bieżącej karty, żeby zaproponować wyczyszczenie tej strony albo tego adresu. Treść strony nie
jest czytana.
```

browsingData (1000)
```
Potrzebne do czyszczenia cache, listy pobranych plików, danych witryny i tekstu z formularzy
dla domen i słów wybranych przez użytkownika. Te przełączniki są domyślnie wyłączone i działają
tylko na liście użytkownika, w wybranych przez niego momentach.
```

cookies (1000)
```
Potrzebne do odczytania i usunięcia cookies dla domen i słów wybranych przez użytkownika, żeby
razem z historią zniknęły też ciasteczka sesji i śledzące. Cookies stron z listy zachowanych
zostają nietknięte. Nazwy i domeny cookies są czytane na urządzeniu i nigdzie nie są wysyłane.
```

tabs (1000)
```
Opcjonalne, proszone tylko wtedy, gdy użytkownik włączy czyszczenie cookies strony w chwili
zamykania jej karty. Do tego potrzebny jest adres zamykanej karty, który rozszerzenie trzyma w
pamięci sesji, czyli w RAM, do momentu jej zamknięcia. To uprawnienie nie jest proszone przy
instalacji i nie służy do niczego innego.
```

## Kod zdalny

Nie. Wszystko jest w pakiecie: żadnych skryptów z sieci, żadnego eval, żadnego Wasm z zewnątrz.

## Wykorzystanie danych

Zaznacz `Historia online`. To jedyny rodzaj danych, z którymi rozszerzenie pracuje.

Pozostałych ośmiu nie zaznaczaj. Nie czyta treści stron, nie śledzi kliknięć, myszy ani
klawiatury, nie ma kodu lokalizacyjnego, kont, wiadomości, danych płatniczych ani zdrowotnych.

Zaznacz wszystkie trzy oświadczenia: nie sprzedaję i nie przekazuję danych użytkowników osobom
trzecim, nie używam ich do celów innych niż jedyne przeznaczenie, nie używam ich do ustalania
zdolności kredytowej ani udzielania pożyczek.

Polityka prywatności wspomina PIN od aktualizacji z 19 września 2026 („A PIN you set yourself,
if you switch the list lock on..."), więc opis i polityka się zgadzają. Nie ma tu nic do
dopisania.

## Gdzie stoją liczby

- Limity pól zachowane: opis 1624/16000, jedno przeznaczenie 433/1000, najdłuższe uzasadnienie
  uprawnienia 321/1000.
- Opis przechodzi polską bramkę stylu (`pl_check.py --register pl-ui`): 0 błędów, 1 ostrzeżenie
  o łańcuchach przecinków (1,11 przy progu 1,2). Zdania mają średnio 13,8 słowa (czysta polska
  prasa: 18,0), najdłuższe 25 (tam 55), a pauzy en 16,1 na 1000 słów (tam 15,3).
- Wszystkie trzy oświadczenia w zakładce prywatności muszą być zaznaczone, inaczej formularz się
  nie wyśle.
