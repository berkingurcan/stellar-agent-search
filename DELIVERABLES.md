# SOW Teslimat Talimatları

## Mevcut durum

- [x] GitHub repo public: github.com/berkingurcan/stellar-agent-search
- [x] npm package yayınlandı: stellar-agent-search@0.1.0
- [x] 13 read-only MCP tool çalışıyor (mainnet)
- [x] CI/CD kurulu
- [x] Developer docs tamam
- [x] x402 demo script dry-run ile doğrulandı
- [ ] Cüzdan fund edilmesi gerekiyor
- [ ] P2-08 blocker (Scrapper http→https fix) bekleniyor
- [ ] 3 ekran kaydı

---

## Adım 1 — Cüzdan fund et (D2 için)

Cüzdan zaten oluşturuldu:
- Public: `GCMIFDCJQDPXE3DIANOLOVEQIYOEY33XFHAHGX5FDUZHUHZEAPB3T37Y`
- Secret: `examples/.env` içinde

### 1a. XLM gönder
- Binance/Coinbase'ten yukarıdaki adrese **5 XLM** gönder
- Stellar Expert'te adresi kontrol et: https://stellar.expert/explorer/public/account/GCMIFDCJQDPXE3DIANOLOVEQIYOEY33XFHAHGX5FDUZHUHZEAPB3T37Y
- "Trustlines" bölümünde sadece XLM görünmeli

### 1b. USDC trustline ekle
XLM geldikten sonra çalıştır:
```bash
npx -y stellar-agent-search@0.1.0 add-usdc-trustline
```
Eğer bu komut yoksa manuel olarak:
```bash
npx tsx -e "
import { Keypair, Server, Asset, Operation, TransactionBuilder } from '@stellar/stellar-sdk';
const server = new Server('https://horizon.stellar.org');
const kp = Keypair.fromSecret('SBNUX33452L5LBADIWZFWVS5P6WJVCRPQYV25VYYBP42E2MWZZAQM75I');
const usdc = new Asset('USDC', 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5REYM40X6UC');
const account = await server.loadAccount(kp.publicKey());
const tx = new TransactionBuilder(account, { fee: '100', networkPassphrase: 'Public Global Stellar Network ; September 2015' })
  .addOperation(Operation.changeTrust({ asset: usdc }))
  .setTimeout(30)
  .build();
tx.sign(kp);
const result = await server.submitTransaction(tx);
console.log('Trustline added:', result.hash);
"
```

### 1c. USDC al
- Binance/Coinbase'ten adrese **1 USDC** gönder (Stellar network, USDC)
- Trustline geldikten sonra gönder

### 1d. Doğrula
```bash
npx -y stellar-agent-search@0.1.0 doctor
```
Tüm check'ler yeşil olmalı.

---

## Adım 2 — P2-08 blocker'ı çöz (D2 için)

Scrapper agent'ın x402 endpoint'i `http://` döndürüyor, script `https://` bekliyor.

**Yapman gereken:** Trion Labs / Scrapper sahibine şu mesajı gönder:

> Scrapper agent (id 10) x402 challenge'ı `resource.url` olarak `http://scrapper.stellar8004.com/task` döndürüyor. 
> `https://scrapper.stellar8004.com/task` olması gerekli. Express app'te trusted proxy / public base URL 
> konfigürasyonunu düzeltmek yeterli. Funded run bu fix'i bekliyor.

Doğrulama komutu (fix sonrası):
```bash
curl -sI -X POST https://scrapper.stellar8004.com/task | head -1
# 402 dönmeli, ardından:
npx tsx -e "
const r = await fetch('https://scrapper.stellar8004.com/task', { method: 'POST' });
const h = r.headers.get('payment-required');
const d = Buffer.from(h, 'base64').toString();
const j = JSON.parse(d);
console.log('resource.url:', j.resource.url);
// https:// olmalı
"
```

---

## Adım 3 — Recording 1: 4 tool Claude Code'da (D1)

**Süre:** 2-3 dk · **Para gerekmez**

### Hazırlık
```bash
npx -y stellar-agent-search@0.1.0 setup --client claude --scope user --handshake
```
Çıktıda `added` ve 13 tool listesi görünmeli. Claude Code'u yeniden başlat.

### Kayıt adımları
1. Ekran kaydını başlat (QuickTime / OBS / Loom)
2. Claude Code'da `/mcp` yaz → `stellar-agent` connected, 13 tools görünecek
3. Şunu sor: *"Use find_agent to find a paid web scraper with a good reputation"*
4. Şunu sor: *"Now rank_agent on agent 10 with verification on"*
5. Şunu sor: *"Show me the full profile for agent 10"*
6. Şunu sor: *"List x402 service candidates"*
7. stellar8004.com'u aç, agent 10'u göster — aynı veri
8. Kaydı durdur, YouTube'a unlisted olarak yükle

---

## Adım 4 — Recording 3: Temiz kurulum (D3)

**Süre:** 1-2 dk · **Para gerekmez**

### Hazırlık
Yeni bir kullanıcı hesabı veya container'da yap (temiz ortam).

### Kayıt adımları
1. `node -v` → 22+ görünmeli
2. Cursor MCP ayarlarında boş liste olduğunu göster
3. Çalıştır:
   ```bash
   npx -y stellar-agent-search@0.1.0 setup --client cursor --scope project --handshake
   ```
4. Çıktıda `added`, 13 tool listesi görünmeli
5. Çalıştır (idempotency proof):
   ```bash
   npx -y stellar-agent-search@0.1.0 setup --client cursor --scope project --check --handshake
   ```
6. Çalıştır:
   ```bash
   npx skills add berkingurcan/stellar-agent-search --skill mcp
   ```
7. Cursor'ı yeniden başlat → Settings → MCP → `stellar-agent` connected
8. `find_agent({ "query": "web scraper" })` çağır → canlı sonuçlar
9. İsteğe bağlı:
   ```bash
   npx -y stellar-agent-search@0.1.0 doctor
   ```
10. Kaydı durdur, YouTube'a yükle

---

## Adım 5 — Recording 2: x402 mainnet demo (D2)

**Süre:** 3-5 dk · **Gerçek USDC harcar ($0.0001)**

### Ön koşullar
- Adım 1 (cüzdan fund) tamam
- Adım 2 (P2-08 fix) tamam
- `npm run build` çalıştırılmış (dist/ mevcut)

### Prova (kamera dışı, 2 kez)
```bash
cd examples
DRY_RUN=1 npx tsx x402-demo.ts
```
Preflight + discovery temiz olmalı, "skipping payment" yazmalı.

### Kayıt adımları
1. `examples/x402-demo.ts`'yi kısaca göster
2. Güvenlik notunu göster (README'deki env-allowlist paragrafı)
3. Dry run çalıştır:
   ```bash
   DRY_RUN=1 npx tsx x402-demo.ts
   ```
4. Gerçek run:
   ```bash
   npx tsx x402-demo.ts | tee examples/run-$(date +%Y%m%d).log
   ```
5. Süreç boyunca:
   - Discovery → agent 10 bulunur
   - HTTP 402 challenge
   - x402 ödeme → **tx hash 1** (kaydet!)
   - Scrape result
   - Reputation feedback → **tx hash 2** (kaydet!)
6. stellar.expert'te her iki tx hash'i aç, confirmed göster
7. `examples/run-<timestamp>.json`'u göster (receipt)
8. Kaydı durdur

### Kayıt sonrası
- tx hash'leri `docs/evidence.md` §2'ye ekle
- Video linkini `docs/evidence.md` §2'ye ekle

---

## Adım 6 — evidence.md güncelle

3 video linki + 2 tx hash'i `docs/evidence.md`'ye ekle:
- §1: Recording 1 link
- §2: Recording 2 link + 2 tx hash
- §3: Recording 3 link
- Tüm ⬜'ları ✅ yap

---

## Öncelik sırası

| Sıra | İş | Bağımlılık | Süre |
|---|---|---|---|
| 1 | Recording 1 (Claude Code) | Yok | 10 dk |
| 2 | Recording 3 (temiz kurulum) | Yok | 10 dk |
| 3 | Cüzdan fund | XLM transfer | 30 dk |
| 4 | P2-08 fix | Scrapper sahibi | Beklemede |
| 5 | Recording 2 (x402 demo) | 3 + 4 | 30 dk |
| 6 | evidence.md güncelle | 1,2,5 | 10 dk |
