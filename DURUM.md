# DURUM — DeepBlame

> **Yeni sohbete başlarken bu dosyayı yükle.** Projenin ne olduğunu, nerede kaldığımızı ve neden bu kararları verdiğimizi anlatır. Mimari doküman "ne yapılacak"ı, bu dosya "ne yapıldı ve neden"i anlatır.

**Son güncelleme:** 27 Eylül 2026
**Faz:** 0 ✅ · **Faz 1'in büyük kısmı ✅** (kayıt + maliyet çalışıyor) → kalan: diğer adaptörler + indeks
**İsim:** DeepBlame ✅ · **Logo:** ✅ (`brand/`) · **GitHub org ✅** · **deepblame.com ✅ alındı** · **npm `deepblame` ✅ yayında (0.1.0)**
**Canlı:** github.com/deepblame/deepblame (public) · npmjs.com/package/deepblame · `npx deepblame init` dünyanın her yerinden çalışıyor
**Kod:** `init`, `status`, `log`, `show`, `cost`, `seal`, `hooks`. 68 test geçiyor; CI Windows + macOS + Linux'ta yeşil (gerçek makinelerde doğrulandı).

---

## 1. Ürün tek cümlede

Birden fazla yapay zekâ ajanının aynı kod tabanında çalıştığı yazılım ekipleri için: kodun her satırını hangi ajanın **neden** yazdığını kaydeden ve bir şey bozulduğunda **sadece o ajanın işini** geri almayı sağlayan geliştirici aracı.

`git blame` kimin yazdığını söyler. Biz neden yazdığını söyleriz.

## 2. İsim — KESİNLEŞTİ

**DeepBlame.** 17 Eylül 2026'da karar verildi.

| Varlık | Durum |
|---|---|
| `deepblame.com` | ✅ **Alındı** (27 Eylül, Hostinger, 3 yıl, oto-yenileme açık) |
| `deepblame.dev` | ⬜ Boş — isteğe bağlı |
| npm `deepblame` | ✅ **Yayında** — 0.1.0, sahibi `yusufozguryilmaz` |
| GitHub org `deepblame` | ✅ **Alındı**, repo public: github.com/deepblame/deepblame |

**Neden bu isim:** Her geliştirici `git blame`'i bilir. "DeepBlame" duyunca ne olduğunu anında anlıyor — açık kaynak dağıtımında sıfır açıklama gerektiren bir isim büyük avantaj. Ayrıca üç varlığın (com, dev, npm) birden boş olması nadir.

**Bilinen zayıflığı:** "Blame" günlük dilde suçlama demek; mühendislik kültüründe "blameless postmortem" değeri var. **Çözüm: tagline mesajı suçlama değil çözüm üzerine kursun.**

> DeepBlame — ajanın yazdığı kodu dört saat değil dört dakikada çöz.

**CLI:** `deepblame` (kısa alias: `dblame`, henüz eklenmedi)

**Logo (21 Eylül, final):** blok "D" işareti + condensed wordmark ("Deep" kalın, "Blame" ince). Marka rengi nane yeşili **#31DB8E**. Dosyalar `brand/` altında: `logo-light.png` (açık zemin), `logo-dark.png` (koyu zemin), `logo-mono-black.png`, `mark-green/black/white.png` (şeffaf PNG). Not: ton Supabase yeşiline yakın, lansman öncesi bir kez daha bakılacak.

**Elenen isimler:** Cairn, Colophon, Truagent, Trage, Magenty, Trueline, Lovelace, Hopper, Braid, Sextant, Provenir, Attest, Strata, Tally (dolu), Notch (dolu), Shim (dolu), RunTrace (com+dev dolu, iki yerleşik rakip), SiltLedger, OriginShim, Delvo, Vestige, Sigil, Argus, Deckard, Theseus.

## 3. Konumlandırma — ÖNEMLİ

Araştırma gösterdi ki **kimse "atıf" veya "köken kaydı" aramıyor.** Geliştirici anketlerinde öncelikler: maliyet verimliliği ve halüsinasyon kontrolü.

- ❌ Kullanma: "Ajan köken kaydı ve atıf sistemi"
- ✅ Kullan: **"Ajanın yazdığı kod bozulduğunda dört saat değil dört dakikada çöz"**
- ✅ İkincil: **"Aracın ölse bile geçmişin kalsın"** (Gemini CLI kayboluyor, Roo Code arşivlendi — ekosistem dengesiz, bu gerçek bir korku)

Atıf mekanizma, satılan şey sonuç.

## 4. Altı modül

1. **Yakalama** — ajan harness'larına takılan hook'lar, olayları yerel kuyruğa yazar (<15ms, bloklamaz)
2. **Atıf motoru** — `blame --why`, satır seviyesinde span soy zinciri + güven skoru. **Projenin teknik hendeği.**
3. **Cerrahi geri alma** — `revert --agent C --since 6h`, çakışma tespitiyle
4. **Panel** — zaman çizelgesi, risk skorlaması, ajan karnesi, maliyet paneli
5. **Politika kapıları** — CI'da YAML kuralları, PR bloklama
6. **Denetim raporu** — imzalı, hash zincirli, kurcalanma kanıtlı

## 5. Adaptör önceliği (değişti)

1. **OpenCode** ← öncelik 1. 195k yıldız, 16M aylık geliştirici, MIT, 75+ sağlayıcı. Rakip değil, **dağıtım kanalı.**
2. Claude Code (tam hook seti)
3. Codex (sarmalayıcı süreç)
4. Cursor (dosya izleyici, istem alınamıyor)
5. Genel/bilinmeyen (git hook yedeklemesi — her zaman çalışır)

**Faz 1'de sıra değişti:** önce **Claude Code** yazıldı. Sebep: OpenCode'un eklenti API'sini doğrulamak için dokümantasyona erişmek gerekiyordu ve erişilemedi; Claude Code'un hook yüzeyi ise elimizde kesin olarak var. Yakalama katmanı adaptörden bağımsız yazıldığı için OpenCode eklemek artık tek dosyalık iş.

## 6. Ticari model

| Katman | Fiyat | İçerik |
|---|---|---|
| Açık Kaynak | $0 sonsuza kadar | CLI'ın tamamı, yerel, sınırsız |
| Bulut Free | $0 | 1 repo, 3 geliştirici, 14 gün geçmiş |
| Team | $24/geliştirici/ay | Sınırsız repo, 1 yıl, PR botu, politika |
| Enterprise | $1.500+/ay | SSO, on-prem, denetim raporu, SLA |

- **Ters deneme:** 14 gün Team özellikleri, sonra Free'ye düşer (~%8 dönüşüm vs saf freemium %2-5)
- **Dönüşüm tetikleyicisi:** yerel defter makineye özel → ikinci kişi kurunca paylaşımlı panel gerekiyor. Yapay duvar değil, fiziksel gerçek.
- **Ödeme:** Polar veya Lemon Squeezy (merchant of record → Türkiye'den satışta ABD şirketi gerekmez)
- **Yapısal avantaj:** ücretsiz kullanıcı maliyeti ~$0 (CLI tamamen yerel) → başabaş eşiği ~%0

**Projeksiyon:** 12. ay ~$5.800/ay, 24. ay ~$22.400/ay, brüt marj %98+

## 7. Rekabet

| Oyuncu | İlişki |
|---|---|
| OpenCode (195k⭐) | Dağıtım kanalı, rakip değil |
| pacifio/atlas | En yakın. Ama ortam değiştirmeni istiyor; pre-1.0, sadece macOS |
| Forklane.ai | Fikrin ticari hali, küçük |
| Dust ($20M ARR, %240 NRR, 0 churn) | **Rakip değil, tezin kanıtı.** Farklı segment |
| **GitHub Agent HQ** | **Asıl tehdit** — tarafsız + devasa dağıtım |
| Anthropic/OpenAI | Kendi ekosistemleri için → hendeğimiz burada |

**Kategori kilitlenmemiş** ama süresiz değil. Hız stratejinin parçası.

## 8. Talep kanıtı

**Destekleyen:**
- Geliştiricilerin %90'ı ajan kullanıyor, %59'u üç+ araç paralel (→ tarafsızlık tezi)
- Güven %40 → %29 düştü
- AI kodu PR başına 1,7 kat fazla sorun
- İnceleme 11,4 sa/hafta > yazma 9,8 sa/hafta
- Şirket başına 12 ajan → 2027'de 20, %50'si tek başına çalışıyor
- Sektör kendi kelimeleriyle: "ajan kodunu ayıklamanın en zor kısmı, prodüksiyon belirtisini sorumlu ajan değişikliğine geri bağlamak"

**Çürüten (bunu unutma):**
- METR: deneyimli geliştiriciler kendi depolarında ajanlarla **%19 daha yavaş**
- Ajanlar olgun kod tabanlarında greenfield'a göre belirgin kötü → hedef senaryomuz nadir olabilir
- Anketlerde kimse "atıf" istemiyor

## 9. Teknoloji yığını

- CLI + daemon: TypeScript, Node ≥ 20 (çalışma zamanı); geliştirme Node 22
- **Şu an kurulu sürümler:** TypeScript 7.0, Vitest 5, esbuild 0.28, zod 4, pnpm 10.28
- Git: `git` plumbing'e shell out, kabuk yok (`execFileSync`): `hash-object`, `mktree`, `commit-tree`, `update-ref`, `rev-list`, `ls-tree`
- Diff: histogram + token seviyesi ikincil diff (Faz 2)
- Yerel: NDJSON kuyruk (hazır, boş) + SQLite indeks (Faz 1; native bağımlılık olduğu için Faz 0'a alınmadı)
- Defter: `refs/deepblame/ledger` (ayrı git ref'i — çakışmasız birleşme)
- Panel: Next.js 15, React, Tailwind, shadcn/ui
- DB: Postgres (Neon) + Drizzle · Kimlik: Clerk · Röle: Node+ws (Fly.io)
- Rust portu: sadece `blame` p95 > 200ms olursa

## 10. Kritik tasarım kararları

1. **Kod asla makineden çıkmaz** — sunucuya sadece metadata (yol, satır aralığı, hash). İstemler varsayılan hash'li.
2. **Defter değişmez, `run_id` ile anahtarlı** → iki defterin birleşimi = küme birleşimi → merge çakışması **yapısal olarak imkânsız**
3. **Paylaşımlı oturumda CRDT YOK** — tek ajan süreci, tek otoritatif akış var; eşzamanlı birleştirme değil kesin sıralama lazım → sunucu-otoriter röle
4. **Müdahale ve devretme atıflı** — rakipler işbirliğine odaklanıp bunu atlıyor, ayrıştığımız yer burası
5. **Yakalama bloklamaz** — hook sadece kuyruğa yazar, ağır iş daemon'da
6. **Belirsizliği gizleme** — güven skoru göster, düşük güvenli atıfları işaretle

## 11. İnşa sırası

| Faz | Süre | Çıkış kriteri |
|---|---|---|
| 0 · İskelet | 3 gün | `npx deepblame init` temiz repoda hatasız |
| 1 · Yakalama + defter | 1,5 hafta | Kendi repomuzda eksiksiz kayıt |
| 2 · Köken motoru | 2,5 hafta | `blame --why` çalışıyor, 40 senaryo geçiyor |
| 3 · Cerrahi geri alma | 1 hafta | 3 ajanlı senaryoda kayıpsız geri alma |
| **4 · Açık kaynak lansmanı** | 1 hafta | **500+ yıldız, 20+ kurulum** |
| 5 · Senk + panel | 2 hafta | — |
| 6 · GitHub App + politika | 1,5 hafta | — |
| 7 · Paylaşımlı oturumlar | 2 hafta | — |
| 8 · Denetim + ödeme | 1 hafta | — |

**Toplam ~13 hafta, ama gerçek plan ilk 4 hafta.** Faz 4'ten sonrası kullanıcı geri bildirimiyle yönlenecek. Belirsizliğin tamamı Faz 2'de.

## 12. Performans bütçeleri (kabul kriteri, hedef değil)

- Hook ek yükü p95: **< 15 ms** — ⚠️ **şu an ~55 ms** (ölçüm: bulut konteynerinde 20 çağrı ortalaması; bunun 27 ms'i Node'un kendi açılışı). Node süreci başına düşen maliyet bu bütçenin altına inemez. Faz 2'de daemon + ince istemci ile çözülecek; o zamana kadar gerçek rakam burada yazılı duracak. Karşılaştırma: tam CLI ile 70 ms, ayrı `deepblame-capture` paketiyle 55 ms.
- `blame` 5.000 satır p95: **< 200 ms**
- Daemon boşta CPU: **< 1%** · Bellek: **< 120 MB**
- Defter büyümesi: **< 2 KB/run**
- İlk indeksleme 10k commit: **< 90 sn**

## 13. Repo yapısı

**Bugün var olan:**

```
deepblame/
├── packages/
│   ├── protocol/     # isim sabitleri (TEK yer), Run şeması, defter meta şeması (zod) + kuyruk olay tipleri (bağımlılıksız)
│   ├── core/         # git plumbing, defter, durum dizini, tespit, yakalama (capture), mühürleyici (seal), okuma (runs), blame, revert, share, report, doctor, gc
│   ├── cli/          # `deepblame` + `deepblame-capture` komutları, esbuild ile iki dosyaya paketlenir
│   └── vscode/       # VS Code eklentisi: saf karar katmanı (annotate.ts) + ince editör katmanı, core gömülü
├── brand/            # logo seti
├── examples/         # pull-request-comment.yml — hazır GitHub Action
├── .github/workflows/ci.yml   # ubuntu + macOS + Windows × Node 22/24: tip + test + build + smoke
├── DURUM.md, README.md, LICENSE (Apache-2.0)
```

**Fazlarında eklenecek:** `packages/adapters/` (Faz 1), `packages/policy/` (Faz 6), `apps/web` (Faz 5), `apps/github-app` (Faz 6), `apps/relay` (Faz 7). Boş paket açılmadı.

pnpm workspaces. `protocol` ve `core` yayınlanmayan iç paketler: TS kaynağı doğrudan export ediliyor (derleme adımı yok), CLI hepsini tek dosyaya paketliyor. `core` saf ve izole test edilebilir, ileride Rust'a taşınabilir.

**Komutlar:** `pnpm install` · `pnpm check` (tip + test + build) · `pnpm smoke` (paketlenmiş CLI'ı temiz repoda dener) · `pnpm test` · `pnpm build` · `node packages/cli/dist/deepblame.mjs status`

## 14. Çalışma yöntemi

**Rol dağılımı:**
- **Kullanıcı:** kararlar, hesap açma (GitHub org, Vercel, Neon, alan adı), deploy, kodu çalıştırıp test etme, lansman paylaşımları, topluluk
- **Claude:** mimari, kod üretimi, testler, dokümantasyon, landing metni, araştırma

**Döngü:** spesifikasyon → onay → kod → kullanıcı test eder → düzeltme → sonraki modül. Aynı anda birden fazla modül açık tutulmaz.

**Her oturum sonunda bu dosya güncellenir.**

## 15. Faz 0 — ne yapıldı (21 Eylül 2026)

**Çıkış kriteri karşılandı:** paketlenmiş CLI (`npm pack` → `npm exec`) temiz bir repoda hatasız çalıştı.

- `deepblame init`: `refs/deepblame/ledger` genesis commit'ini sadece plumbing ile yazar (checkout yok, index yok, hook yok), `.deepblame/` durum dizinini açar, ajan araçlarını tespit eder. Tekrar çalıştırmak güvenli; silinen durum dizinini geri getirir, düzenlenmiş config'e dokunmaz.
- `deepblame status`: defter (oluşturma tarihi, kayıtlı run sayısı), kuyruk, tespit edilen ajanlar, kaydın açık/kapalı olduğu. `--json` ve `-C <dizin>` destekli.
- Ajan tespiti: OpenCode (`opencode.json(c)`, `.opencode/`, PATH), Claude Code (`.claude/`, `CLAUDE.md`, PATH), Codex (`.codex/`, PATH), Cursor (`.cursor/`, `.cursorrules`, PATH). `AGENTS.md` birden fazla araç tarafından okunduğu için tek başına hiçbir aracı işaret etmiyor.
- Olay şeması (`Run`, schema_version 1): mimari dokümandaki alanlar + katı doğrulama (bilinmeyen alanı reddeder, bitişin başlangıçtan önce olmasını, kendi kendinin ebeveyni olmayı, ne öncesi ne sonrası olan dosya yazımını reddeder). sha1 ve sha256 git repoları destekli.

**Doğrulama:** 35 test (protocol 10, core 14, cli 11). Test ortamı boş global git config ile çalışıyor (kimlik yok, imza yok). Ayrıca gerçek makine config'i ile (`commit.gpgsign=true`) elle smoke test: HEAD değişmedi, çalışma ağacı temiz, defter commit'i imzasız. sha256 repo ve git worktree senaryoları test edildi.

**Paket:** npm tarball 47 KB, bağımlılıksız tek dosya (`dist/deepblame.mjs`, 197 KB, bilinçli olarak minify edilmedi; 173 KB'ı zod). Ölçülen süreler: `--version` ~100 ms, `status` ~150 ms (7 git çağrısı). Etkileşimli komutlar için yeterli; hook yolu için değil (bkz. Faz 1 madde 2).

### Faz 0'da verilen kararlar (mimari dokümandan sapmalar)

1. **Durum dizini kendi `.gitignore`'unu taşıyor (`*`).** Doküman "kullanıcının .gitignore'una ekler" diyordu; bu yol kullanıcının dosyasını hiç değiştirmiyor, `git add -A` bile dizini alamıyor.
2. **Hook kurulumu Faz 1'e kaydı.** Yakalama komutu yokken hook yazmak ajanları bozardı. `init` şimdilik ajanları tespit edip raporluyor; hook'ları Faz 1'de kuracak.
3. **Defter commit'leri `--no-gpg-sign` ve sabit kimlikle** (`DeepBlame <ledger@deepblame.dev>`). Kullanıcının git kimliği gerekmez, imza istemi bir ajanı asla bloklamaz. Defter bütünlüğü kendi hash zincirinden gelecek (Faz 8).
4. **`config.toml` yerine `config.json`** — TOML ayrıştırıcı bağımlılığı olmasın.
5. **Şimdilik 3 paket** (protocol, core, cli); diğerleri kendi fazlarında.
6. **CLI çıktısı ve README İngilizce** (global ürün, Show HN/GitHub kitlesi). DURUM.md Türkçe kalıyor.
7. **Paket bilinçli olarak minify edilmiyor:** kodunu izleyen bir araca güvenmek için insanlar kodu okuyabilmeli.
8. **Kayıt sayısı** defter ağacındaki `runs/` altından okunuyor; Faz 1'de her run `runs/<run_id>.json` olarak yazılacak.
9. **Windows (21 Eylül):** CI matrisine `windows-latest` eklendi. Ajan tespiti Windows kurallarına göre çalışıyor: yalnızca PATHEXT uzantılı dosyalar komut sayılıyor (npm'in `opencode.cmd`'si evet, uzantısız bash kısayolu hayır), çalıştırma izni aranmıyor. Bu kurallar platform parametresiyle her işletim sisteminde test ediliyor. Repo yolları Windows'ta yerel biçimde (`C:\...`) gösteriliyor. `.gitattributes` ile satır sonları her sistemde LF. Smoke testi bash yerine Node betiği (`pnpm smoke`), sonuçları doğruluyor.
10. **macOS düzeltmesi:** geçici klasör macOS'ta sembolik bağın arkasında (`/var` → `/private/var`), Windows CI'da kısa adla (`RUNNER~1`) görünüyor; git ise gerçek yolu veriyor. Testler bu yüzden CI'da kırılacaktı, gerçek yol kullanılarak düzeltildi.

## 16. Faz 1 — ne yapıldı (26 Eylül 2026)

**Ürün artık gerçekten kaydediyor.** Claude Code bir dosyaya dokunduğunda, o turun tamamı deftere bir run kaydı olarak giriyor.

**Akış:** hook → `deepblame-capture` (kuyruğa bir satır) → ajan durunca mühürleyici → `refs/deepblame/ledger` içinde `runs/<run_id>.json`.

- **Yakalama (`packages/core/src/capture.ts`)** — sıcak yol. Şema kütüphanesi yok, git süreci yok, ağ yok, `try/catch` ile sarılı: yakalama hatası ajanı asla bloklamaz, hiçbir şey stdout'a yazmaz, her zaman 0 ile çıkar. Repo kökünü `.git`'i yukarı doğru arayarak bulur (git çağırmadan). Dosya blob oid'lerini git ile birebir aynı şekilde kendisi hesaplar (sha1 ve sha256 repoları, testte `git hash-object` ile karşılaştırılıyor). 4 MB üstü ve ikili dosyalar sadece yol olarak kaydedilir.
- **Ayrı paket (`deepblame-capture`, 9,7 KB)** — ana CLI 259 KB olduğu için hook yolu kendi paketini kullanıyor: 70 ms yerine 55 ms.
- **Satır aralıkları** — `Edit`/`MultiEdit` için hunk'lar, düzenlemeden *sonraki* dosya üzerinden hesaplanıyor: değişen metnin öncesi aynı kaldığı için yeni metnin satır numarası eskisinin de satır numarasıdır. Boş `new_string` (saf silme) konumlandırılamıyor, hunk üretilmiyor — Faz 2'de pre içeriği saklanınca çözülecek.
- **Mühürleyici (`seal.ts`)** — kuyruğu turlara böler (bir istem turu açar, `Stop`/`SessionEnd` kapatır, ikinci istem öncekini kapatır), her kapalı turu zod ile doğrular, geçersizse *reddedip* sebebini bildirir. Yazma: kendi geçici index dosyasıyla (`GIT_INDEX_FILE`) `read-tree` → `update-index` → `write-tree` → `commit-tree` → `update-ref` (eski değer verilerek, yarış varsa 3 deneme). Kullanıcının index'ine, HEAD'ine, çalışma ağacına dokunulmuyor.
- **Kuyruk güvenliği** — kilit dosyası (60 sn'de bayatlar), yarım yazılmış son satır korunur, mühürleme sırasında gelen olaylar kaybolmaz, bitmemiş tur kuyrukta bekler.
- **Claude Code adaptörü (`hooks.ts`)** — `.claude/settings.json` içine 6 hook: SessionStart, UserPromptSubmit, PreToolUse (yalnızca dosya yazan araçlar), PostToolUse (tümü), Stop, SessionEnd. Kullanıcının mevcut ayarları ve kendi hook'ları olduğu gibi kalıyor; `hooks uninstall` yalnızca bizimkileri siliyor.
- **`init` artık hook'ları da kuruyor** (ajan tespit edildiyse). `--no-hooks` ile atlanır, `--local` ile `settings.local.json`'a yazılır. Kurulan komut: PATH'te varsa `deepblame-capture`, yoksa paketin yanındaki `capture.mjs` mutlak yolla.
- **Okuma** — `deepblame log` (tek `git cat-file --batch` süreciyle tüm run'lar), `deepblame show <run>` (git gibi ön ek eşleşmesi), `deepblame seal`, `deepblame hooks install|uninstall|status`.
- **Gizlilik** — deftere istem metni girmiyor; sadece sha256'sı ve isteğe bağlı tek satırlık "intent" (`.deepblame/config.json` → `capture.intent`, `capture.prompt_text`). Makine ve worktree kimlikleri hash'li (`hostId`, `worktreeId`), okunabilir yol veya kullanıcı adı yok.
- **Doğrulama:** 59 test (protocol 10, core 30, cli 19) + `pnpm smoke`: paketlenmiş CLI temiz bir repoda kuruluyor, bir ajan turu hook'lar üzerinden besleniyor, run deftere düşüyor, `git status` yalnızca ajanın düzenlediği dosyayı gösteriyor.

### Faz 1'de verilen kararlar

11. **`init` hook'ları kendiliğinden kuruyor.** Doküman ayrı bir komut öngörüyordu. Gerekçe: "kur ve çalışsın" deneyimi; ne yapıldığı çıktıda açıkça yazıyor ve tek komutla geri alınabiliyor.
12. **İki paket (`deepblame` + `deepblame-capture`).** Sıcak yolun 259 KB'lık paketi ayrıştırması saçma; ayrı 9,7 KB'lık paket 15 ms kazandırıyor.
13. **Turlar istemle başlar, `Stop` ile biter.** Oturum değil tur = run. Bitmemiş tur mühürlenmez, kuyrukta bekler; yarım bir run kaydından iyidir.
14. **Blob içerikleri henüz saklanmıyor**, yalnızca oid'ler. Cerrahi geri alma için içerik gerekecek (Faz 3); defter ağacına `blobs/` eklenecek ki git gc silmesin. Kod hiçbir zaman senkronize edilmeyecek, sadece yerelde durur.
15. **Boş turlar kaydedilmiyor** (araç çağrısı, okuma ve yazma yoksa) — defteri gürültüyle doldurmamak için.
16. **`log` ve `show` kendiliğinden mühürlüyor** (`--no-seal` ile kapatılır): hook'lar bir sebeple çalışmadıysa bile kayıt kaybolmaz.
17. **Bilinmeyen modelin fiyatı tahmin edilmiyor.** Maliyet raporunda yanlış bir rakam, rakam olmamasından kötüdür. Kullanıcı kendi fiyatını config'e yazabiliyor.
18. **Maliyet verisi ajanın kendi oturum kaydından okunuyor**, ayrı bir API çağrısı veya anahtar gerekmiyor. Dolayısıyla maliyet, kaydın olduğu her yerde ücretsiz geliyor.
19. **npm yayını elle tetikleniyor** (`release.yml`, Actions sekmesinden). Push'a bağlı otomatik yayın yok: yayın bilinçli bir karar olmalı.
20. **npm'de token ile yayın yapılamıyor.** Hesapta 2FA açıkken npm, granular token'la bile tek kullanımlık kod istiyor (`EOTP`) — "yazma işlemleri için 2FA" ayarını kapatmak bile değiştirmedi. Bugünkü yayın şöyle yapıldı: Claude kendi konteynerinde `npm publish` başlattı, npm bir onay linki üretti, kullanıcı linke tıklayıp geçiş anahtarıyla onayladı, yayın tamamlandı. Kalıcı çözüm: npm **trusted publishing** (OIDC) — paket artık var olduğu için kurulabilir, token gerekmez.
21. **Defter artık içerik de saklıyor** (yerelde, git nesnesi olarak). Kanıtlanamayan atıf yapmamak ve geri almayı mümkün kılmak için şart. Kod hâlâ makineden çıkmıyor; senkronizasyon sadece metadata gönderecek.
22. **blame kanıtlayamadığı satırı talep etmiyor.** Yanlış ajanı işaret eden bir araç, hiç olmayan araçtan kötüdür.
23. **Commit kaydı ajanın satırını çalmıyor.** Git yedeği her aracı kapsasın diye var, hook'la izlenen ajanın yerine geçsin diye değil.
24. **Codex'in global config'ini biz değiştirmiyoruz.** Script'i yazıp tek satırlık ayarı kullanıcıya bırakıyoruz.

### 27 Eylül — yayına çıkış ve maliyet katmanı

**Yayına çıkış (hepsi tamam):** repo public olarak GitHub'a yüklendi, CI altı işin altısında yeşil (ilk gerçek Windows ve macOS koşusu), `deepblame.com` alındı, npm paketi yayınlandı. `npx deepblame init` temiz bir makinede baştan sona denendi ve çalışıyor.

**Windows'ta çıkan tek gerçek hata:** yol kısaltma fonksiyonu `/` varsayıyordu, Windows `\` kullanıyor; `hooks install` ve `status` kısa yol yerine tam yolu basıyordu. Düzeltildi, artık her platformda test ediliyor (`format.ts`, `relativeTo`).

**Maliyet katmanı (yeni):**
- `transcript.ts` — Claude Code'un oturum kaydını (JSONL) okur, turun zaman aralığına düşen asistan mesajlarının token kullanımını ve model adını toplar. Mühürleyicide çalışır, sıcak yolda değil. Bozuk satır, eksik dosya, 64 MB üstü dosya: sessizce atlanır.
- `pricing.ts` — bildiğimiz modellerin fiyat tablosu (en uzun ön ek eşleşmesi). **Bilmediğimiz model için tahmin yürütmez, parayı `null` bırakır.** Repo kendi fiyatını `.deepblame/config.json` → `pricing` altına yazabilir; o her zaman kazanır. Ajanın kendi bildirdiği maliyet varsa (bazı sürümler `costUSD` yazıyor) o tercih edilir.
- Run kaydına `model` ve `cost` alanları geldi: `input_tokens`, `output_tokens`, `cache_write_tokens`, `cache_read_tokens`, `usd` (null olabilir), `source` (`rates` | `harness`).
- `deepblame cost [--days N]` — dönem toplamı, token dökümü, modele ve ajana göre kırılım. `log` çıktısına da tur başı maliyet sütunu eklendi.

### 27 Eylül (akşam) — blame, git yedeği, Codex

**`deepblame blame <dosya>` çalışıyor.** Ürünün asıl vaadi artık kodda:
- Her run'ın bıraktığı dosya hali defterde **içerik olarak** duruyor (yeni). Yakalama, dosyayı `.deepblame/blobs/<oid>` altına kopyalıyor; mühürleyici bunu git nesne deposuna yazıp defter ağacına `blobs/<ilk2>/<kalan>` olarak bağlıyor — böylece `git gc` silemiyor. Cerrahi geri alma da bunu kullanacak.
- blame, her run için "o run'ın bıraktığı hal" ile "dosyanın bugünkü hali" arasında `git diff` alıp kaydedilen satır aralıklarını bugüne taşıyor. Araya giren düzenlemeler satırı kaydırdıysa takip ediyor, satırın üstüne yazıldıysa **iddiayı bırakıyor.**
- Güven skoru uydurma değil: dosya run'ın bıraktığı halle birebir aynıysa %100, arada başka yerler değiştiyse ama satır aynen geldiyse %90. Takip edilemeyen satır "bilinmiyor" diyor.
- İçeriği defterde bulunmayan run'lar satır talep etmiyor; çıktıda kaç run'ın kanıtsız kaldığı yazıyor.

**Git yedeği (her araçta çalışır).** `deepblame hooks install --agent git` bir `post-commit` hook'u kuruyor; her commit deftere bir run olarak giriyor (değişen dosyalar, gerçek satır aralıkları, commit mesajı intent olarak, yazan kişi `actor`). Başkasının post-commit hook'u varsa korunuyor, kaldırırken sadece bizim satırımız siliniyor. **Önemli kural:** commit run'ları, hook'la izlediğimiz bir ajanın satırını asla elinden almıyor.

**Codex / tur bazlı adaptör.** `hooks install --agent codex`, `.deepblame/codex-notify.sh` yazıyor; kullanıcı bunu kendi `~/.codex/config.toml` dosyasına tek satırla bağlıyor (proje dışındaki bir config'i biz değiştirmiyoruz). Mekanizma: her tur sonunda çalışma ağacının fotoğrafı alınıyor, bir öncekiyle farkı o turun işi sayılıyor. Kaba bir yöntem, o yüzden hook'u olan ajanlarda kullanılmıyor.

**OpenCode:** native eklenti yazılmadı. Eklenti API'sini doğrulayacak dokümana erişemiyoruz; tahminle kod yazıp "destekliyoruz" demek bu üründe yapılacak en yanlış şey olurdu. OpenCode kullanıcıları bugün git yedeğiyle kapsanıyor, ayrıca `deepblame record-turn` komutunu kendi eklentilerinden çağırabiliyorlar. Doğrulanır doğrulanmaz yazılacak.

**Testler:** 85 (protocol 10, core 56, cli 19).

### Faz 1'den kalanlar

1. ~~Git yedeği~~ ✅ · ~~Codex~~ ✅ · **OpenCode native eklentisi** — API doğrulanınca.
2. ~~Model ve maliyet~~ ✅ 27 Eylül'de yapıldı.
3. **SQLite indeks** — `log` ve `blame` şu an her run blob'unu okuyor; blame ayrıca run başına bir `git diff` süreci açıyor. Yüzlerce run'da yavaşlar.
4. **Daemon** — hook başına 55 ms'yi 15 ms'nin altına indirmek için.
5. **Kendi üstümüzde dogfood:** hook'lar bu repoya kuruldu ama Claude Code ayarları oturum başında okuduğu için gerçek kayıt bir sonraki oturumda başlayacak.
6. **npm trusted publishing** kurulacak.
7. **blame'in kalan zorlukları:** dosya yeniden adlandırma takibi, birleşme (merge) sonrası satır takibi, biçimlendirme (prettier) sonrası "aynı satır mı" kararı. Bunlar mimari dokümandaki 40 senaryo testinin konusu.
8. **Defter boyutu:** artık dosya içerikleri de defterde. Git sıkıştırıyor ve aynı içerik tekilleşiyor ama uzun vadede budama (eski blob'ları atma) politikası gerekecek.

**Paralel (kullanıcı):**
- `deepblame.com` ve `deepblame.dev` alınacak
- Repo GitHub org'a push edilecek (org açıldı, CI hazır, ilk gerçek Windows koşusu orada olacak)
- npm hesabı açılacak (2FA); `deepblame` adı ilk yayınla rezerve edilecek

### 27 Eylül (gece) — cerrahi geri alma, blame dayanıklılığı, hız, OpenCode

Dördü de bitti. Ürünün vaat ettiği her şey artık kodda.

**1. `deepblame revert` — cerrahi geri alma.** Ürünün üçlemesini tamamlayan parça (`revert.ts`).
- Yöntem: **ters yönlü üç yollu birleştirme değil, cerrahi dikiş.** Defter, run'ın hangi satırları değiştirdiğini biliyor. Önce "run'ın bıraktığı hal" ile "ondan önceki hal" arasındaki en küçük fark çıkarılıyor; sonra o satır aralıkları dosyanın bugünkü haline taşınıyor; metin hâlâ run'ın bıraktığı metinse yerine eski satırlar konuyor. Sonuç: **ajanın işi gidiyor, sonradan yazılan her şey kalıyor.**
- Neden düz `git merge-file` yetmiyor: git, yan yana satırlardaki iki değişikliği çakışma sayıyor. Ajan ile insan çoğu zaman yan yana satırlara dokunuyor. Bizim git'te olmayan bir bilgimiz var (hangi satır kimin), o yüzden daha iyisini yapabiliyoruz. Gerçek testte: ajan `upload.js`'e retry döngüsü ekledi, insan aynı dosyada `export` satırını değiştirdi → revert retry'ı aldı, export değişikliği kaldı. `git merge-file` bunu çakışma verip bırakıyordu.
- Güvenlik kuralları (hepsi test edilmiş): `--apply` yazılmadıkça **hiçbir şey yazılmıyor**, sadece plan gösteriliyor. Çakışma varsa dosyaya dokunulmuyor; `--conflicts` dersen git'in kendi `<<<<<<<` işaretleriyle yazıyor, editörde çözüyorsun. **Ajanın oluşturduğu ama sonradan senin düzenlediğin dosya asla silinmiyor** (`--conflicts` ile bile — yarım silinmiş dosya diye bir şey yok). Defterde içerik kalmamışsa tahmin yürütmüyor, "kanıtsız" diyor. İkili (binary) dosya: dosya run'dan beri hiç değişmemişse birebir geri konuyor, değiştiyse dokunulmuyor.
- Seçim: `--run <id>` (tek tur, ön ek yeter), `--agent <ad>` (o ajanın tüm işi), `--hours <n>` (son N saat). Birden çok run aynı dosyaya dokunmuşsa yeniden eskiye doğru tek tek geri alınıyor.
- Çıkış kodu: eksik kalan dosya varsa 1 (betikler anlasın).

**2. blame'in zor senaryoları.**
- **Yeniden adlandırma** (`rename.ts`): `git mv a.js b.js` sonrası `blame b.js` ajanı buluyor. Commit edilmiş ve henüz commit edilmemiş (staged) taşımaların ikisi de takip ediliyor, zincir hâlinde (a→b→c). Çıktı dosyanın eski adını da yazıyor. Revert de dosyayı yeni adıyla bulup oraya yazıyor.
- **Biçimlendirme / prettier**: dosyanın girintisi baştan sona değişse bile satır kaybolmuyor. Katı karşılaştırma satırı bulamazsa **boşlukları yok sayan ikinci bir karşılaştırma** yapılıyor; satır oradan bulunursa güven `%70` ve gerekçe "sadece boşluk değişmiş, muhtemelen hâlâ onun". Kodun kendisi değiştiyse yine sahiplenmiyor.
- **Merge**: birleştirme commit'i hiçbir satır yazmadığı için **hiç run oluşturmuyor** (doğrusu bu — satırları asıl commit'ler yazdı). Ajanın satırı iki dalın birleşmesinden sonra da ajanda kalıyor.
- Güven kademeleri artık üç: `%100` birebir, `%90` başka yer değişti satır aynen geldi, `%70` sadece boşluk değişti.
- Satır takibi `diffmap.ts`'e çıkarıldı; blame ve revert aynı motoru kullanıyor (iki ayrı kopya bakımı yapılmıyor).

**3. Hız.**
- **Run indeksi** (`runindex.ts`): `.deepblame/runs.index.ndjson`. Her run için sadece seçim için gerekenler (zaman, ajan, model, yazdığı yollar, maliyet, kaydın nesne kimliği). Komutlar önce indeksten hangi run'ların gerektiğine karar veriyor, sonra **yalnızca onları** okuyor. Sonuçlar (1200 run'lık test reposunda): `log --limit 20` 55 ms → **26 ms ve artık run sayısıyla büyümüyor**; `blame` tüm defteri okumak yerine sadece o dosyaya dokunan run'ları okuyor, **50 ms**; `cost` tek kayıt bile açmıyor, hepsini indeksten topluyor.
- İndeks **sadece önbellek**: sil, bir sonraki komut defterden yeniden kurar. Ekle-only NDJSON; sonuna yazılan "head" satırı sayesinde yarıda kalmış yazım bozuk dosya bırakmıyor, fazlalık satırlar okurken atılıyor. Bozuk/eski sürüm indeks görülürse çöpe atılıp yeniden kuruluyor. Yeni run gelince baştan kurmuyor, sadece eklenen kayıtları ekliyor.
- blame ayrıca: run başına bir `cat-file -e` yerine hepsi için tek süreç; aynı hali bırakan run'lar tek `git diff` paylaşıyor; **dosyanın tüm satırları sahiplendiği anda duruyor** (uzun geçmişli dosyada 30 `git diff` yerine 1).
- **Hook gecikmesi 58 ms → 42 ms.** Sebep: yakalama paketi artık **CommonJS**, ESM değil. Node'un ESM yükleyicisi ~20 ms tutuyordu. Node'un kendi açılışı 27–30 ms (bizim elimizde değil), bizim payımız 28 ms → **15 ms**, yani bütçenin içinde. `child_process` sadece turu mühürlerken yükleniyor; Node 22+ varsa bytecode önbelleği açılıyor. Daemon'a şimdilik gerek yok — kalan süre Node'un açılışı, onu ancak kalıcı süreç çözer ve bedeli (bayat soket, yetim süreç, Windows named pipe) bu kazanca değmez.

**4. OpenCode eklentisi — yazıldı, tahminle değil.** Eklenti API'sini npm'den `@opencode-ai/plugin@1.18.32` ve `@opencode-ai/sdk@1.18.32` paketlerini indirip **kendi tip tanımlarından** doğruladık:
- `Plugin = (input: PluginInput, options?) => Promise<Hooks>`; `PluginInput = { client, project, directory, worktree, serverUrl, $, experimental_workspace }`
- `"chat.message"(input: { sessionID, … }, output: { message, parts })` → kullanıcının istemi (`parts[].text`)
- `"tool.execute.before"(input: { tool, sessionID, callID }, output: { args })` → düzenlemeden **önceki** dosya hali
- `"tool.execute.after"(input: { tool, sessionID, callID, args }, output: { title, output, metadata })` → sonraki hal + araç kaydı
- `event({ event })` → `session.idle` (turun sonu, `properties.sessionID`) ve `message.updated` (`properties.info` = `AssistantMessage`: `cost: number`, `tokens: { input, output, reasoning, cache: { read, write } }`, `modelID`, `providerID`)
- Yani **OpenCode'da maliyeti biz hesaplamıyoruz, OpenCode'un kendi rakamını alıyoruz** — Claude Code'da oturum kaydını madenciliğe göre daha güvenilir. `deepblame show` bunu "(agent-reported)" diye işaretliyor.
- Eklenti dosyası `.opencode/plugin/deepblame.js` olarak projeye yazılıyor, `init` OpenCode'u tespit ederse kendisi kuruyor. Okunabilir, 40 satır, tek işi olayları JSON'a çevirip yakalama komutuna vermek. Kaldırırken sadece bizim yazdığımız dosya siliniyor (başkasının eklentisine dokunulmuyor). Dosya testte Node ile modül olarak **sözdizimi kontrolünden geçiriliyor**, yani bozuk kod kimsenin editörüne düşmüyor.
- Doğrulayamadığımız tek şey: `edit`/`write` araçlarının argümanında dosya yolunun alan adı. Tahmin etmek yerine **toleranslı** yazıldı: `filePath`, `file_path`, `path`, `file` sırayla deneniyor; hiçbiri yoksa o düzenleme sessizce kaydedilmiyor (yanlış kaydetmek yerine kaydetmemek).

**Herkese açık giriş kapısı (yeni ve önemli).** Her araç için adaptör yazmak ölçeklenmiyor; her zaman duymadığımız bir araç olacak. Artık **belgelenmiş tek bir JSON şekli** var, stdin'den tek satır: `{"kind":"prompt"|"read"|"write-pre"|"write"|"tool"|"usage"|"end", "agent":…, "session":…, …}`. SDK yok, bağımlılık yok, sürümümüzü takip etme zorunluluğu yok. Kendi OpenCode eklentimiz bunun üstünde 40 satır. README'de örneğiyle duruyor. Bu hem entegrasyon maliyetini sıfıra indiriyor hem de "vendor-neutral" iddiasını somutlaştırıyor.

**Testler:** 130 (protocol 10, core 97, cli 23). `pnpm smoke` Linux'ta geçiyor.

### Faz 1 — kalanlar (güncel)

1. ~~Git yedeği~~ ✅ · ~~Codex~~ ✅ · ~~OpenCode native eklentisi~~ ✅
2. ~~Model ve maliyet~~ ✅
3. ~~İndeks~~ ✅ (SQLite değil, NDJSON önbellek — bağımlılık eklemeye gerek kalmadı)
4. ~~blame'in zor senaryoları~~ ✅ (rename, prettier, merge)
5. ~~Cerrahi geri alma~~ ✅
6. **Daemon** — şimdilik gerekmiyor (yukarıdaki gerekçe). Node'un açılışı 27 ms'nin altına inmezse ve kullanıcılar şikâyet ederse yeniden bakılacak.
7. **Kendi üstümüzde dogfood** — hook'lar kurulu, gerçek kayıt bir sonraki Claude Code oturumunda başlayacak.
8. **npm trusted publishing** kurulacak (şimdilik yayın web-OTP ile elle yapılıyor).
9. **Defter budama politikası** — dosya içerikleri defterde duruyor; git sıkıştırıp tekilleştiriyor ama uzun vadede eski blob'ları atma kuralı gerekecek.
10. **Sıradaki büyük iş: takım defteri** — run'ları paylaşılan bir uzak depoya göndermek, PR kontrolü ("bu diff'i hangi ajan yazdı"), imzalı denetim raporu.

### 27 Eylül (geç saat) — Cursor, doctor, gc

**Cursor adaptörü — tahminle değil, doğrulanmış.** Cursor 1.7 ile tam bir hook API'si geldi; `cursor.com/docs/hooks` üzerinden alan adlarını doğruladık.
- Dosya: `.cursor/hooks.json`, `{ "version": 1, "hooks": { "<olay>": [{ "command": ... }] } }`. Bizimki oradaki listeye bir giriş olarak ekleniyor, başkasının hook'una dokunulmuyor, kaldırırken sadece bizimki siliniyor.
- Bağlandığımız olaylar: `sessionStart`, `beforeSubmitPrompt` (istem), `beforeReadFile` (okuma), `afterFileEdit` (düzenleme), `stop` (tur sonu).
- **Cursor'da düzenlemeden *önce* çalışan bir hook yok**, yani dosyanın eski hâlini anlık yakalayamıyoruz. Gerek de yok: `afterFileEdit` değiştirilen metni birebir veriyor (`edits[].old_string` / `new_string`), biz de dosyanın bugünkü hâlinden o değişiklikleri geri alarak eski hâli **yeniden kuruyoruz.** Tahmin değil, harness'in bize söylediğinden hesap. Metin beklenen yerde bulunamazsa uydurmuyor, `pre_blob` boş bırakılıyor.
- Payload'da `conversation_id` (oturum), `model`, `transcript_path`, `workspace_roots` var — hepsi kullanılıyor.
- `init` Cursor'u tespit ederse hook'ları kendisi kuruyor. 11 test.

**`deepblame doctor` — "neden kayıt tutmuyor" sorusunun cevabı.** Bu sorunun birinci destek konusu olacağı belli; aracın kendi sessizliğinin hesabını verebilmesi lazım. Kontroller: depo, defter (kaç run, sonuncusu ne zaman), durum dizini, hangi adaptörler kurulu, **projede kullanılan ama bağlanmamış ajan** (gerçekte en sık sorun bu), kuyrukta takılı olaylar, ölü kalmış mühürleme kilidi, ve son 40 run'ın kaydettiği içeriğin hâlâ durup durmadığı. Her satır ne yapılacağını da yazıyor. Gerçekten bozuk bir şey varsa çıkış kodu 1, yani CI'da kullanılabilir.

**`deepblame gc` — defterin sonsuza kadar büyümesini engelliyor.** Belirtilen süreden eski run'ların **içerikleri** bırakılıyor, **kayıtları** duruyor. Sonrasında `blame` o satırlarda ajanı hâlâ söylüyor ama "kanıtsız" diye işaretliyor, `revert` o kadar geriye gidemiyor.

Burada yazarken bir şey keşfettim ve tasarımı değiştirdim: **blob'u en yeni ağaçtan çıkarmak yetmiyor.** Defter append-only olduğu için her eski commit'in ağacı o blob'u işaret etmeye devam ediyor, git de asla toplamıyor. İlk yazdığım gc hiçbir yer boşaltmıyordu. Gerçekten bırakmak için defterin commit zincirinin **tek bir commit'e sıkıştırılması** gerekiyor. Bedeli açıkça söyleniyor: bütün run kayıtları korunuyor, defterin mühür-mühür geçmişi korunmuyor. `--apply` olmadan hiçbir şey yazılmıyor.

**Testler:** 146. `pnpm smoke` geçiyor.

### Ürünün bugünkü şekli

Kurulum bir kere (`npx deepblame init`), sonra unutuluyor. Sorular çıktığında dört komut: `blame`, `cost`, `revert`, `doctor`. Takım için `push` / `pull` / `report`. Terminale girmek istemeyen için VS Code eklentisi aynı deftere bakıyor.

**Ücretsiz / ücretli çizgisi (karar 25):** kendi makinende çalışan her şey ücretsiz ve açık kaynak — bütün komutlar, bütün adaptörler, sınırsız. Ücretli olan tek şey **paylaşım**: takım defteri, web paneli, PR kontrolü, imzalı denetim raporu, SSO. Tek geliştirici paylaşıma ihtiyaç duymaz, şirket duyar; ödeyecek olan da şirket.

### Kalan eksikler (öncelik sırasıyla)

1. **Sıfır dış kullanıcı.** En büyük eksik bir özellik değil. Başkasının makinesinde ne kırılıyor bilmiyoruz. Önce 10 gerçek kullanıcı, bir hafta onların takıldığı yerler.
2. ~~**VS Code eklentisi**~~ → yapıldı (aşağıda).
3. ~~**Takım katmanı**~~ → `push` / `pull` / `report` yapıldı (aşağıda).
4. Kendi üstümüzde gerçek dogfood.
5. ~~npm trusted publishing~~ → yapıldı, 0.2.0 imzalı provenance ile yayında.

### 27 Eylül (gece yarısı) — alt ajan hatası, takım defteri, PR raporu, VS Code eklentisi

**Alt ajan hatası — kaydın ortadan bölünmesi.** Claude Code bir alt ajan (Task) çalıştırdığında `SubagentStop` geliyordu ve biz onu turun bitişi sayıp defteri mühürlüyorduk. Oysa alt ajanın bitmesi, turun bitmesi değil: asıl tur devam ediyor ve geri kalan düzenlemeleri **ikinci bir run** olarak kaydediliyordu. Yani alt ajan kullanan her turda kayıt ikiye bölünüyor, `blame` aynı işi iki farklı run'a dağıtıyordu. Düzeltme tek satır — `SubagentStop` (ve Cursor'daki `subagentStop`) artık hiçbir şey yapmıyor, sadece `Stop` / `SessionEnd` mühürlüyor. İki test: bir turun bir tur olarak kaldığını ve Task ile Edit çağrılarının ikisinin de aynı run'a düştüğünü kanıtlıyor.

**Takım defteri (`packages/core/src/share.ts`).** Defter bir git ref'i olduğu için paylaşımı git'in zaten iyi yaptığı şey: `push` ve `pull`.

Tasarımın can alıcı kısmı birleştirme. İki defteri, ikisindeki bütün girdileri alarak birleştiriyoruz, çünkü **çakışma yapısı gereği imkânsız**: bir run kaydının yolu kendi uuid'si ve kayıt yazıldıktan sonra asla değişmiyor; saklanan dosya içeriğinin yolu ise içeriğinin hash'i. Dolayısıyla iki makine aynı yola farklı bir şey yazamaz. Yazarsa bu bir hata ya da kurcalanmış defterdir: o zaman yereldeki korunuyor ve durum açıkça söyleniyor — sessizce bir taraf seçilmiyor.

Tek istisna defterin kendi künyesi (`meta.json`): iki kişi ayrı ayrı `init` çalıştırdığı için her defter kendi doğum tarihini taşıyor. Birleştirmede **erken olan** korunuyor, çünkü bu kaydın başladığı an odur. Bunu birim testler değil, iki klon ve bir çıplak depo ile yapılan **gerçek deneme** yakaladı: ilk hâli bunu "imkânsız çakışma" diye rapor ediyordu.

Kritik olan şu: **içerikler de gidiyor.** `pull` sonrası karşı makine iş arkadaşının run'ını sadece görmüyor, üzerinde `blame` ve `revert` de yapabiliyor. 8 test, biri tam bunu kanıtlıyor.

**PR raporu (`packages/core/src/report.ts` + `examples/pull-request-comment.yml`).** Bir dalın ne kadarını ajan yazmış: `merge-base`, sonra `--unified=0` ile **sadece bu değişikliğin dokunduğu satırlar**, sonra blame aralıklarıyla kesişim. Bütün dosyayı blame'lemek haftalar önce incelenmiş işi rapor etmek olurdu. `--markdown` yorum biçimini veriyor; Action kendi önceki yorumunu güncelliyor, her push'ta yenisini eklemiyor. Gerçek bir dalda doğrulandı.

**VS Code eklentisi (`packages/vscode`).** Ajanın yazdığı her satırın solunda yeşil işaret (kaydırma çubuğunda da, uzun dosyanın şeklini görmek için), imlecin olduğu satırın sonunda ajan adı + istem, üstüne gelince model, maliyet, ne kadar emin olduğu ve **o run'ı geri alan bağlantı** (önce planı gösteriyor, onay olmadan hiçbir şey yazılmıyor).

İki karar:
- **Çekirdek pakete gömülü, CLI'ya kabuk çağrısı yapmıyor.** Açılan her dosyada `npx deepblame` başlatmak defteri okumaktan pahalıya gelirdi. Ayrıca CLI'nın kurulu olmadığı depoda da çalışıyor.
- **Kaydedilmemiş düzenlemede işaretler kayıyor, dokunulan satırdaki işaret bırakılıyor.** Blame diskteki dosyayı okuyor; biri yazmaya başladığı an tampon ile cevap ayrışıyor. İşaretleri dondurmak ya da daha kötüsü altından kayan satırı göstermeye devam etmek yerine, her değişiklik altındaki satırları kaydırıyor ve dokunulan satırı bırakıyor: elle düzenlenen satır artık kanıtlanabilir şekilde ajanın değil. Bu, ürünün göze alamayacağı tek hata. Bırakılan işaret kayıtta sıra gelince geri geliyor.

**Test edilebilirlik.** Eklenti buradan bir editörde çalıştırılamıyor, o yüzden tersten test edildi: `test/fake-editor.ts` editörün yerine geçiyor, ne çizilmesinin istendiğini kaydediyor, testler de **gerçek eklentiyi gerçek bir depo ve gerçek bir defter** üzerinde sürüyor — 53 test (38 saf mantık, 15 uçtan uca). Kasıtlı bir birim hatası (0 tabanlı satır dönüşümünü bozmak) sekiz testi düşürüyor, yani testler gerçekten tutuyor. Derlenmiş paket ayrıca `vscode` modülü dışarıdan verilerek node'da yüklendi: `activate` çalışıyor, dört komut kaydoluyor, `deactivate` temiz çıkıyor.

`.vsix` paketlendi (7 dosya, 66 KB). **Doğrulanamayan tek şey görünüm:** yeşilin temada nasıl durduğu, hover kutusunun nereye düştüğü, uzun satırın sonunda notun nasıl göründüğü. Kuran ilk kişi söyleyecek.

**Testler:** 214. `pnpm check` geçiyor.

### 28 Eylül — Windows doğrulandı, 0.3.0

Yükleme sonrası CI kendiliğinden çalıştı ve **altı işin hepsi geçti** — Windows dahil. Aylardır açık duran "Windows hiç denenmedi" maddesi böylece kapandı (yukarıda 17. bölümde işaretlendi).

**Sürüm 0.3.0.** npm'deki 0.2.0'da `push` / `pull` / `report` **yok**. Kendi verdiğimiz GitHub Action örneği `npx deepblame@latest report` çağırıyor; yani bugün onu kopyalayan biri hata alırdı. Yayınlanması şart, kozmetik bir sürüm artışı değil. Eklenti de aynı numarada tutuldu (0.3.0) — iki ayrı numara takip etmeye değmez.

### 28 Eylül — 0.3.1: npx tuzağı

**Bulunan hata, bugüne kadarki en kötüsü.** 0.3.0'ı yayınladıktan sonra paketi npm'den indirip README'deki adımları **birebir** uyguladım. Şu çıktı:

`npx deepblame init` çalışırken npx, CLI'ı geçici olarak PATH'e koyuyor. `init` de "`deepblame-capture` PATH'te var" diye görüp hook'a o ismi yazıyor. npx bitince o isim yok oluyor. Sonuç:

- Kullanıcı README'nin ilk komutunu çalıştırıyor
- Ekranda yeşil "Recording is on" yazıyor
- Ajan çalışıyor, **hiçbir şey kaydedilmiyor**
- `doctor` bile "✓ recording" diyor, çünkü sadece ayar dosyasında bizim hook'umuz var mı diye bakıyordu, komutun çözümlenip çözümlenmediğine bakmıyordu

Yakalayıcı asla ekrana bir şey yazmaz ve her zaman 0 ile çıkar — sıcak yolda doğru olan bu, ama burada acımasız: hata tamamen sessiz. Sıfır dış kullanıcımız var ve README'nin ilk komutu bu; yani gelecek **herkes** bu duvara çarpardı ve hiçbiri nedenini anlamazdı.

**İki cevap verildi.**

1. **Hook artık isim çağırmıyor, dosya çağırıyor.** `init`, 20 KB'lık yakalayıcıyı deponun kendi `.deepblame/bin/` klasörüne kopyalıyor ve hook'a tam yolunu yazıyor. PATH'e, npm önbelleğinin ömrüne, CLI'ın kurulu kalmasına bağımlı hiçbir şey kalmadı. Boş bir ortamda (`env -i`, PATH yok) gerçekten denendi: hook çalışıyor, olay kuyruğa düşüyor, `blame` doğru cevabı veriyor. Bedeli: kopya CLI yükseltilince kendiliğinden güncellenmiyor, o yüzden yanına sürümü yazılıyor ve `init` her çalıştığında tazeleniyor.
2. **`doctor` artık hook komutunun gerçekten çözümlendiğini kontrol ediyor** — çalıştırmadan: yol ise dosya var mı, isim ise PATH'te mi. Asıl kıymetli kısım bu. Bu ailenin bundan sonraki bütün hataları (depo taşındı, kopya silindi, node yolu değişti) sessiz olmaktan çıkıp `✗ hook  ... nothing is being recorded` satırına dönüyor, ve `doctor` 1 ile çıkıyor.

Ders: **yayınlanan paketi indirip kullanıcının adımlarını birebir uygulamadan "çalışıyor" denmiyor.** 228 test bu hatayı göremezdi, çünkü testler yakalayıcıyı zaten doğru yoldan çağırıyordu. Hatayı gören tek şey gerçek `npx` oldu.

**Sonra CI kırmızı yandı ve peşinden üç şey daha çıktı.** İlki Windows'tandı, diğer ikisini ararken bulundu:

1. **Windows'ta node'un yolunda boşluk var** (`C:\Program Files\nodejs\node.exe`). `doctor`'ın komut ayrıştırıcısı boşluktan bölüyordu, yani Windows'ta sağlam duran her hook'u "bozuk" ilan ediyordu. Ayrıştırıcı artık tırnakları anlıyor. Aynı hata ikinci bir şeyi de gizliyormuş: tırnaklı komutlarda betiğin var olup olmadığı hiç kontrol edilmiyordu.
2. **Arka planda mühürleme hiç çalışmıyormuş.** Tur bitince yakalayıcı `node <kendisi> seal` çalıştırıyordu — ama yakalayıcı mühürleyici değil, o komutu tanımıyor bile. Yani hiçbir şey olmuyordu; tur, mühürleyen bir komut (`blame`, `log`, `status`) gelene kadar kuyrukta bekliyordu. Veri kaybı yok, ama söz verilen şey olmuyordu. **Bu hata vendoring'den önce de vardı**, sadece kimse bakmamıştı. Artık CLI da yakalayıcının yanına kopyalanıyor ve mühürleyici o oluyor.
3. **npm/npx CLI'ın önüne bir "shim" koyuyor**, yani `argv[1]` gerçek dosya değil. Kopyalanacak dosyaları isimden tahmin etmek yakalayıcıyı buluyor, mühürleyiciyi kaçırıyordu. Artık önce `realpath` ile gerçek dosyaya inip yanındakilere bakılıyor.

Bir de neredeyse kaçırdığım bir şey: mühürleyiciyi bulmak için `CLI_NAME` sabitini protokol paketinin ana girişinden aldım ve **yakalayıcı paketi 20 KB'dan 208 KB'a çıktı** — barrel dosyası zod'u da içeri çekiyordu. Sıcak yolda her araç çağrısında 10 kat fazla kod. Doğrudan `@deepblame/protocol/names`'ten alınınca 20 KB'a döndü. Ölçüldü: hook gecikmesi hâlâ 31–45 ms.

**Asıl kazanç `smoke`'un değişmesi.** Eskiden yakalayıcıyı doğrudan çağırıyordu — bu yüzden hiçbirini göremedi. Artık:
- `init`'in **ayar dosyasına gerçekten yazdığı komutu** okuyup onu çalıştırıyor (bir ajan ne yapacaksa o)
- PATH'ten **bizim bütün ikili dosyalarımızı çıkararak** çalıştırıyor (git duruyor, mühürleyicinin ona ihtiyacı var)
- ve turun **kendi kendine mühürlendiğini** CLI'a hiç komut vermeden, doğrudan git'ten kontrol ediyor

Bu üç madde birleşince, bu ailenin hataları artık her yayından önce CI'da üç işletim sisteminde yakalanıyor.

**Testler:** 231. `smoke` üç kontrol daha yapıyor.

## 17. Açık sorular

- **Claude Code hook şeması kendi bilgimizden yazıldı** (dokümantasyona erişilemedi: alan adı izin istedi, kullanıcı reddetti). Alan adları (`hook_event_name`, `tool_name`, `tool_input.file_path`, `old_string`/`new_string`, `session_id`) doğru biliniyor ama **gerçek bir Claude Code oturumunda henüz doğrulanmadı.** İlk dogfood turunda kontrol edilecek; yanlış alan varsa `capture.ts` içinde tek yerde düzelir.
- Cursor'un hook yüzeyi yeterli mi? (Faz 8'e ertelendi)
- Köken motoru uzun düzenleme zincirlerinde ne kadar bozulur? (Faz 2'de 40 senaryo testiyle ölçülecek)
- **İki makinede ayrı ayrı `init`** → iki farklı genesis commit. Senk fazında iki defter birleştirilecek (merge commit, küme birleşimi); `status` şimdilik ilk kökü gösteriyor.
- **`git log --all` defteri de gösteriyor** (her `refs/*` gibi). Faz 1'de run'lar arttıkça gürültü olabilir; toplu commit ve dokümantasyonla ele alınacak.
- ~~**Windows henüz gerçek bir makinede çalıştırılmadı.**~~ → **28 Eylül'de kapandı.** CI (`ci #13`) ubuntu + macOS + Windows × Node 22/24 = altı işin hepsinde geçti. Windows'ta sadece testler değil `smoke` de çalıştı: paketlenmiş CLI temiz bir depoda gerçekten çalıştırılıp hiçbir şeye dokunmadığı kontrol edildi. Geriye kalan Windows riski gerçek bir kullanıcının makinesindeki ajan kurulumları (Cursor/Claude Code hook yolları), CI'ın göremeyeceği kısım.
- ~~**Hook gecikmesi 55 ms**~~ → 42 ms, bizim payımız 15 ms (bütçe içinde). Kalanı Node'un kendi açılışı. Daemon ertelendi.
- **`init` ajan ayar dosyasını değiştiriyor.** Kullanıcılar bunu saygısızlık olarak görür mü, yoksa kolaylık mı? İlk geri bildirimlerde ölçülecek; `--no-hooks` var.
- **Fiyat tablosu eskir** (OpenCode'da sorun değil, kendi rakamını veriyor; Claude Code'da geçerli). Model fiyatları değişince `pricing.ts` güncellenmeli; yeni modeller (opus 5 gibi) tabloda yok, kullanıcı config'e yazana kadar maliyet boş görünür. Uzun vadede fiyatları uzaktan çekmek mi gerekir, yoksa sürümle göndermek yeterli mi?
- Çalışma şekli (27 Eylül itibarıyla): **GitHub artık ana kopya.** Claude bulut konteynerinde kodu yazıp test ediyor, değişen dosyaları sohbete gönderiyor; kullanıcı ya dosyaları Finder'dan yerine koyup GitHub Desktop'tan push ediyor, ya da GitHub'ın web arayüzünden yüklüyor. Bu oturumun GitHub'a doğrudan yazma erişimi yok (proxy repo'ya bağlı olmayan API çağrılarını reddediyor). Terminal gerekmiyor.

## 18. Bağlam notu

İki haftalık fikir arama sürecinden sonra bu projede karar kılındı. Elenenler ve sebepleri: ses klonlama (ElevenLabs 11 mlr $), kod inceleme (CodeRabbit 1,5 mlr $), ajan hafızası (Mem0/Cognee fonlanmış), WhatsApp CRM (komoditize), tokenizasyon (Chainlink altyapıyı tutmuş), cihaz test çiftliği (4+ ekip aynı anda yapıyor), viral trend aracı "Whyral" (Virlo'nun SEO hendeği + 7 ödeyen rakip).

**Seçim gerekçesi:** kategoride hâkim oyuncu yok, iki kişiyle yapılabilir, açık kaynak dağıtımı müşteri görüşmesi gerektirmiyor, tavan yüksek.
