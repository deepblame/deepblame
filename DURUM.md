# DURUM — DeepBlame

> **Yeni sohbete başlarken bu dosyayı yükle.** Projenin ne olduğunu, nerede kaldığımızı ve neden bu kararları verdiğimizi anlatır. Mimari doküman "ne yapılacak"ı, bu dosya "ne yapıldı ve neden"i anlatır.

**Son güncelleme:** 21 Eylül 2026
**Faz:** 0 ✅ tamamlandı → sıradaki **Faz 1 (yakalama + defter)**
**İsim:** DeepBlame ✅ kesinleşti · **Logo:** ✅ kesinleşti (`brand/`)
**Kod:** monorepo çalışıyor, `deepblame init` ve `deepblame status` hazır, 35 test geçiyor · hedef platformlar: macOS, Linux, Windows

---

## 1. Ürün tek cümlede

Birden fazla yapay zekâ ajanının aynı kod tabanında çalıştığı yazılım ekipleri için: kodun her satırını hangi ajanın **neden** yazdığını kaydeden ve bir şey bozulduğunda **sadece o ajanın işini** geri almayı sağlayan geliştirici aracı.

`git blame` kimin yazdığını söyler. Biz neden yazdığını söyleriz.

## 2. İsim — KESİNLEŞTİ

**DeepBlame.** 17 Eylül 2026'da karar verildi.

| Varlık | Durum |
|---|---|
| `deepblame.com` | ✅ Boş — alınacak |
| `deepblame.dev` | ✅ Boş — alınacak |
| npm `deepblame` | ✅ Boş (404 doğrulandı) |
| GitHub org `deepblame` | ⬜ Kontrol edilecek |

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

- Hook ek yükü p95: **< 15 ms**
- `blame` 5.000 satır p95: **< 200 ms**
- Daemon boşta CPU: **< 1%** · Bellek: **< 120 MB**
- Defter büyümesi: **< 2 KB/run**
- İlk indeksleme 10k commit: **< 90 sn**

## 13. Repo yapısı

**Bugün var olan:**

```
deepblame/
├── packages/
│   ├── protocol/     # isim sabitleri (TEK yer), Run olay şeması, defter meta şeması — zod
│   ├── core/         # git plumbing, repo açma, defter genesis, durum dizini, ajan tespiti, init/status
│   └── cli/          # `deepblame` komutu (npm paketi), esbuild ile tek dosyaya paketlenir
├── brand/            # logo seti
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

## Faz 1 — sıradaki iş (yakalama + defter)

1. Defter kayıt formatı: `runs/<run_id>.json`, commit başına bir veya toplu run, hash zinciri alanı.
2. **`deepblame capture`**: zod içermeyen ayrı, çok hafif giriş noktası (bütçe <15 ms). Olayı stdin'den alır, `queue.ndjson`'a ekler, çıkar. Ana paket 197 KB olduğu için hook yolu ayrı bir dosya olmalı.
3. Mühürleyici: kuyruğu zod ile doğrular, deftere yazar (önce komut olarak, sonra daemon).
4. OpenCode adaptörü (öncelik 1), sonra Claude Code hook'ları, sonra git yedek hook'u (post-commit).
5. `init` hook'ları kurar; `deepblame uninstall` her şeyi geri alır.
6. SQLite indeks.
7. Kendi repomuzda dogfood: bu repoda yapılan ajan çalışmaları eksiksiz kaydediliyor mu.

**Paralel (kullanıcı):**
- `deepblame.com` ve `deepblame.dev` alınacak
- GitHub org `deepblame` alınacak → bu repo oraya push edilecek (CI hazır)
- npm hesabı açılacak; paket adı ilk yayınla rezerve edilir

## 16. Açık sorular

- GitHub org `deepblame` müsait mi?
- Cursor'un hook yüzeyi yeterli mi? (Faz 8'e ertelendi)
- Köken motoru uzun düzenleme zincirlerinde ne kadar bozulur? (Faz 2'de 40 senaryo testiyle ölçülecek)
- **İki makinede ayrı ayrı `init`** → iki farklı genesis commit. Senk fazında iki defter birleştirilecek (merge commit, küme birleşimi); `status` şimdilik ilk kökü gösteriyor.
- **`git log --all` defteri de gösteriyor** (her `refs/*` gibi). Faz 1'de run'lar arttıkça gürültü olabilir; toplu commit ve dokümantasyonla ele alınacak.
- **Windows henüz gerçek bir makinede çalıştırılmadı.** İlk gerçek doğrulama repo GitHub'a yüklenince CI'da olacak; Windows kuralları şimdilik Linux'ta taklit edilerek test edildi.
- Çalışma şekli: Claude kendi bulut çalışma alanında kodu yazıp test ediyor, projeyi zip olarak teslim ediyor. Kullanıcının terminal kurması gerekmiyor.

## 17. Bağlam notu

İki haftalık fikir arama sürecinden sonra bu projede karar kılındı. Elenenler ve sebepleri: ses klonlama (ElevenLabs 11 mlr $), kod inceleme (CodeRabbit 1,5 mlr $), ajan hafızası (Mem0/Cognee fonlanmış), WhatsApp CRM (komoditize), tokenizasyon (Chainlink altyapıyı tutmuş), cihaz test çiftliği (4+ ekip aynı anda yapıyor), viral trend aracı "Whyral" (Virlo'nun SEO hendeği + 7 ödeyen rakip).

**Seçim gerekçesi:** kategoride hâkim oyuncu yok, iki kişiyle yapılabilir, açık kaynak dağıtımı müşteri görüşmesi gerektirmiyor, tavan yüksek.
