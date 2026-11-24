# Interactive Facades

ریپوی ساخت «نمای اینتراکتیو ساختمان» برای پروژه‌های املاک. هسته (engine) یک بار نوشته شده و برای همه پروژه‌ها مشترک است؛
هر پروژه جدید فقط **داده و assets** است، نه کد. پروژه مرجع: `armas` (۴ نما، ۶۴ واحد، دسکتاپ و موبایل تست‌شده).

قبل از هر کار این‌ها را بخوان:
- `FACADE-SESSION-NOTES.md` (فارسی): رفتار نهایی، فرمت فایل‌ها، چرخه ساخت پروژه، تصمیم‌های فنی و مشکلات قبلی. مرجع اصلی است.
- `README.md`: خلاصه انگلیسی و دستورها.

## قواعد اصلی

1. **کد هسته را برای یک پروژه تغییر نده.** `js/facade.js`, `js/main.js`, `css/facade.css` و `tools/` مشترک‌اند.
   هر چیز مخصوص یک پروژه فقط در `projects/projects.json` و `projects/<id>/` می‌رود.
   اگر نیاز واقعی به تغییر هسته بود (باگ یا قابلیت عمومی)، جدا و با commit مستقل انجام بده و حتماً `armas` را دوباره تست کن.
2. **بدون build و بدون وابستگی** باقی بماند: ES module ساده، بدون npm package در runtime. ابزارهای `tools/` فقط Node (۱۸+) و ffmpeg می‌خواهند.
3. **رنگ و برند** فقط با تغییر متغیرهای `:root` در css (در صورت نیاز override در سطح پروژه، نه fork کردن css).
4. **نسبت تصویر ثابت:** `viewBox` در config باید با ابعاد `view-N.webp` و SVG واحدها یکی باشد.
5. **ویدیوها:** فقط جهت جلو (`trans-N-to-N+1` و `trans-N-to-1`)، همه با تعداد فریم برابر، فریم اول/آخر منطبق با `view-N`/`view-N+1`.
   encode با `-g 4 -bf 0 -crf 28 -pix_fmt yuv420p -movflags +faststart -an` (دلیلش در notes بخش ۴ و ۵).
6. **پلان‌ها** webp با ضلع بلند ۷۲۰px. نماها ~۳۰۰ تا ۷۰۰ KB.
7. داده واحدها از Google Sheet با `tools/sync-sheets.mjs` به `data.json` استاتیک تبدیل می‌شود؛ سایت هیچ‌وقت مستقیم به Google وصل نمی‌شود.
8. `features.tours=false` یعنی حالت نمونه‌کار (بدون دکمه و لینک تور). برای پروژه‌ای که تور واقعی ندارد استفاده شود، نه placeholder.

## ساخت پروژه جدید (چک‌لیست)

ورودی‌هایی که از کاربر لازم است: نام و `id` پروژه، تعداد نماها، رندر هر نما، ترنزیشن‌ها (sprite / دنباله فریم / ویدیو)،
SVG شکل واحدها، لینک CSV شیت، تصاویر پلان تیپ‌ها، لینک تورها و رنگ برند (اختیاری).

0. **ورودی‌ها را بررسی کن قبل از ساخت:** ویوها باید رندر تمیز باشند (اسکرین‌شات از viewer سایت‌ها لوگو و دکمه دارد و قابل استفاده نیست)، همه دقیقاً هم‌اندازه، و ترنزیشن‌ها هم‌اندازه با ویوها.
1. ویوها: `node tools/prepare-views.mjs <id> --src <پوشه> --quality 95` → `assets/view-N.webp` (و `viewBox` را چاپ می‌کند).
2. ترنزیشن‌ها:
   - ویدیو بلند (مثلاً ۵ ثانیه): `node tools/retime-videos.mjs <id> --src <پوشه> --frames 41 --fps 34` → ۴۱ فریم، ~۱٫۲ ثانیه، با حفظ فریم اول و آخر، و چک خودکار تطابق دو سر با ویوها (PSNR). **ویوها باید قبل از این در assets باشند.** مقدار `frames` و `fps` چاپ‌شده را در config بگذار.
   - sprite sheet: `node tools/sprites-to-video.mjs <id>`.
3. واحدها: `node tools/extract-units.mjs <id> <پوشه SVG | legacy.html>` → `units.json`. SVG: یک فایل به ازای هر ویو (`view-N.svg`)، همه با یک `viewBox` برابر ابعاد ویو، هر شکل با `id` (مثل `cca-2-204`) و بدون `transform`.
4. داده: پیش‌نویس شیت را به‌شکل CSV بساز (`projects/<id>/units-draft.csv`، ستون‌های موتور + ستون‌های کمکی مثل `sourceCode`)، در Google Sheet بگذار، لینک را در config بگذار و `node tools/sync-sheets.mjs <id>`. تا شیت نیست، `units.json` و `data.json` خالی (`{"viewBox":[w,h],"views":{"1":[],…}}` و `{}`) موتور را بالا می‌آورد و می‌شود ویو و ترنزیشن را تست کرد.
5. ورودی را به `projects/projects.json` اضافه کن.
6. تست (پایین) و گزارش مشکلات.

## تست

```bash
node tools/serve.mjs 5173        # http://localhost:5173/index.html#/<id>
```

- در این محیط cloud، Chromium و Playwright از قبل نصب‌اند (`require('playwright')`) و `ffmpeg` و Node موجودند.
- حداقل تست: دسکتاپ (۱۴۴۰×۹۰۰) و موبایل (`hasTouch`, `isMobile`، ۳۹۰×۸۴۴)؛ بدون خطای console؛ تعداد `.unit` درست؛ تعویض نما با دکمه؛ tooltip با hover (دسکتاپ) و کارت با tap (موبایل).
- بعد از تعویض نما قبل از اسکرین‌شات حدود ۱ تا ۱.۵ ثانیه صبر کن تا تصویر ثابت جایگزین شود.
- هر واحد در `units.json` باید ردیفی در `data.json` داشته باشد (وگرنه `nodata` و غیرفعال می‌شود) و بالعکس؛ این را با اسکریپت چک و گزارش کن.
- تست واقعی روی گوشی/Safari/iOS و iframe در سایت دیگر هنوز انجام نشده؛ در گزارش صریح بگو چه چیزی تست نشده.

## ساختار ریپو

```
index.html, css/, js/       هسته viewer (مشترک)
tools/                      serve, extract-units, sync-sheets, sprites-to-video, retime-videos, prepare-views
projects/projects.json      فهرست پروژه‌ها + features
projects/<id>/              units.json, data.json, assets/
FACADE-SESSION-NOTES.md     مرجع کامل (فارسی)
```

## نکات اجرایی

- فایل‌های آپلودشده ممکن است پسوند اشتباه داشته باشند (کیت اولیه با پسوند `.zip` در واقع tar بود). با `file` نوع را چک کن و در یک پوشه خالی جدا extract کن.
- `assets/sprites/` (sprite sheet خام) و پوشه‌های `source/` در git نیستند (`.gitignore`)؛ خروجی نهایی mp4 است.
- فایل‌های متنی را با LF نگه دار.
- `features` در `projects.json` سراسری است (همه پروژه‌ها). اگر یک پروژه حالت متفاوتی می‌خواهد (مثلاً `tours: false` فقط برای او)، اول `main.js` باید override در سطح پروژه را پشتیبانی کند (تغییر هسته، commit جدا).
- پروژه‌هایی که در ریپو هستند: `armas` (مرجع کامل)، `couture` (Couture by Cavalli؛ ویو و ترنزیشن آماده، منتظر SVG و داده‌ی واحدها).
- مرز جدی طراحی: روی موبایل پرتره قاب ۱۶:۹ کوچک است و برای ساختمان بلند (مثل couture) ضعیف‌تر دیده می‌شود (notes بخش ۸).
- PR نساز مگر کاربر صریحاً بخواهد. روی branch جلسه commit و push کن.
