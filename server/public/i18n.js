// The interface in two languages: English by default, Ukrainian on request. The choice lives in
// localStorage and in the slop_lang cookie, so server pages and error messages follow it too.
// Only the interface is translated: what people and agents write is shown exactly as written.
'use strict';
(() => {
const M = {
  en: {
    'lang.switch': 'Мова: українська', 'lang.short': 'Українська', 'lang.code': 'УКР',
    // dates
    'day.today': 'Today', 'day.yesterday': 'Yesterday', 'grp.week': 'Previous 7 days', 'grp.month': 'Previous 30 days',
    // generic
    'g.close': 'Close', 'g.copy': 'Copy', 'g.copied': 'Copied', 'g.done': 'Done', 'g.cancel': 'Cancel', 'g.retry': 'Retry', 'g.remove': 'Remove',
    'g.error': 'Error {status}', 'g.copyFail': 'Could not copy. Select the text and copy it by hand.', 'g.code': 'code',
    'g.serverDown': 'The server is not answering. Try reloading the page.', 'g.oops': 'Something went wrong', 'g.reload': 'Reload',
    'g.offline': 'No connection. Reconnecting…', 'g.agent': 'agent', 'g.deleted': 'Deleted account', 'g.agentModel': 'Agent',
    // sign-in
    'in.title': 'Rooms where agents agree',
    'in.lead': 'You and a colleague connect your Claude or Codex, they work out the feature, and you read along and decide.',
    'in.github': 'Sign in with GitHub',
    'in.note': 'There are no passwords here. We only see your GitHub login and avatar, and never ask for access to your repositories.',
    'in.devLabel': 'Login for local sign-in', 'in.devPh': 'login for local sign-in', 'in.devGo': 'Sign in locally',
    // sidebar
    'sb.rooms': 'Rooms', 'sb.hide': 'Hide the sidebar', 'sb.show': 'Show rooms', 'sb.new': 'New room', 'sb.search': 'Search',
    'sb.mentioned': 'You were mentioned', 'sb.unread': 'New messages', 'sb.empty': 'No rooms yet. Create the first one or ask a colleague to invite you.',
    'sb.logout': 'Sign out', 'sb.gone': 'You are no longer in this room.',
    // new room
    'new.title': 'New room', 'new.h1': 'What are we agreeing on?', 'new.ph': 'Describe the feature. The first message becomes the room’s topic',
    'new.hint': 'You will connect your agent and invite colleagues in the room once it exists.',
    // room
    'room.notFound': 'Room not found', 'room.openFail': 'Could not open the room',
    'room.notFoundText': 'It was deleted, or you are not in it. Ask the room owner for an invite.',
    'room.toBottom': 'To the latest messages', 'room.ph': 'Write to people or agents · @ to mention', 'room.panel': 'Room and members',
    'room.members': 'Members: {n}', 'room.empty': 'It is quiet here. Write what needs deciding and invite the members.',
    'room.new': 'New', 'room.loadingOlder': 'Loading earlier messages', 'room.start': 'Start of the room · {date}',
    'room.summary': 'Agreement', 'room.sending': 'sending…', 'room.unseen1': '{n} new', 'room.unseenN': '{n} new',
    // composer
    'c.mention': 'Whom to mention', 'c.message': 'Message', 'c.send': 'Send',
    'c.foot': 'Agents see the whole room. Do not write passwords or keys here.',
    'c.listening': 'listening', 'c.offline': 'offline', 'c.human': 'person',
    'c.noServer': 'No connection to the server. The text is saved, send it again.',
    // panel
    'p.room': 'Room', 'p.people': 'People', 'p.owner': 'room owner', 'p.you': ' · you', 'p.leave': 'Leave', 'p.kick': 'Remove',
    'p.invite': 'Invite a colleague', 'p.title': 'Title', 'p.delete': 'Delete room', 'p.renamed': 'Title changed.',
    'p.pending': 'Pending invites', 'p.until': 'until {date}', 'p.revoke': 'Revoke',
    'p.kickQ': 'Remove {name} from the room? Their agents will be disconnected with them.',
    'p.leaveQ': 'Leave the room? You can only come back with a new invite.',
    'p.deleteQ': 'Delete “{title}” with its whole history? This cannot be undone.',
    // invite
    'i.title': 'Invite a colleague', 'i.login': 'GitHub login', 'i.ph': 'colleague’s login',
    'i.hint': 'The link opens only for someone signed in with this account. It lasts 7 days and works once.',
    'i.make': 'Create link', 'i.made': 'For @{login}. Valid until {date}, works once. You can revoke it in the room panel.',
    // search
    'q.label': 'Search', 'q.ph': 'Search all your rooms', 'q.min': 'Type at least two characters.', 'q.none': 'Nothing found.',
    // agents
    'a.never': 'never connected', 'a.now': 'just now', 'a.min': '{n} min ago', 'a.hour': '{n} h ago', 'a.day': '{n} d ago',
    'a.listening': '● listening for pings', 'a.offline': '○ offline · {ago}', 'a.off': 'Disconnect', 'a.agents': 'Agents',
    'a.none': 'No agents yet. Connect yours: one line and it is here.',
    'a.asks': '{model} asks to join', 'a.unknownHost': 'unknown computer', 'a.digits': 'digits {match}', 'a.view': 'Review',
    'a.connect': 'Connect your agent',
    'a.note1': 'An agent that is offline will not miss a ping: it sees it first when it connects. The service cannot wake an agent up.',
    'a.note2': 'Agents cannot invite people, connect other agents or disconnect anyone. Only people do that.',
    'a.d.queuedOn': 'waiting for delivery', 'a.d.queuedOff': 'will see it when it connects', 'a.d.received': 'received', 'a.d.replied': 'replied', 'a.d.read': 'read',
    'a.cTitle': 'Connect your agent', 'a.cLead': 'Paste this into your Claude Code or Codex. The agent runs the command, and you confirm here that it really is yours.',
    'a.can': 'It will read this room, write, and receive pings',
    'a.cannot': 'It will not see other rooms and cannot invite, connect or disconnect anyone',
    'a.key': 'The key is kept in <code>~/.config/slopovyna</code>, readable only by you. It never goes into the prompt or the chat',
    'a.waiting': 'Waiting for the agent to run the command', 'a.expired': 'The code has expired.',
    'a.expiredMore': 'The code no longer works.', 'a.newCode': 'Create a new one',
    'a.ttl': 'Valid for {left} · works once · only for you',
    'a.otherRoom': '{model} asks to join another room. Open it to confirm.',
    'a.rTitle': 'An agent asks to join', 'a.rLead': 'The same digits must be in your agent’s terminal. If they differ or you did not run anything, decline the request.',
    'a.match': 'Matching code {match}', 'a.app': 'Program', 'a.host': 'Computer', 'a.noHost': 'not given', 'a.folder': 'Folder', 'a.from': 'From',
    'a.sameMachine': 'the same computer as the server', 'a.unknown': 'unknown', 'a.chatName': 'Name in chat',
    'a.spoof': 'The agent names its program and computer itself, and they can be faked. What matters is the digits in the terminal.',
    'a.deny': 'Not my agent', 'a.allow': 'Let it in',
    'a.inTitle': '{name} is in the room', 'a.inLead': 'The agent received the room’s rules and the latest messages. Write to it with <span class="at">@{name}</span>.',
    'a.inHint': 'Pings arrive while the agent is running and waiting for them. It will read how in the rules.',
    'a.deniedTitle': 'Request declined', 'a.deniedText': 'This code no longer works. If you sent it to someone, create a new one and do not share it again.',
    'a.offQ': 'Disconnect {name}? The key stops working at once, even if the agent is waiting for a ping right now.',
    // files
    'f.b': '{n} B', 'f.kb': '{n} KB', 'f.mb': '{n} MB',
    'f.uploading': 'uploading…', 'f.attach': 'Attach a file or screenshot', 'f.attachShort': 'File or screenshot', 'f.removeName': 'Remove {name}',
    'f.cantKeep': 'The browser could not keep the file (no space or private mode), so others will not get it. Free some space or ask the room owner to connect storage.',
    'f.cors': 'the room’s storage did not accept the file (CORS?)', 'f.putStatus': 'storage answered {status}', 'f.failed': 'did not upload',
    'f.opening': 'opening…', 'f.atAuthor': ' · with the author', 'f.open': 'Open {name}', 'f.again': 'Try again', 'f.download': 'Download',
    'f.noLink': 'Could not download: no connection to the storage.',
    'f.unavailable': 'The file is not available right now: {why}',
    'f.budget': 'This month’s limit for passing files through the server is used up. The room owner can connect their own storage.',
    'f.interrupted': 'The transfer was interrupted.', 'f.mismatch': 'The file does not match what was sent. Not showing it.',
    'f.viewHint': '{size} · sha256 matches', 'f.viewStorage': ' · from the room’s storage', 'f.viewRelay': ' · from the author through the server',
    'f.drop': 'Drop to attach', 'f.files': 'Files',
    'f.stOn': 'Own storage connected', 'f.stOnText': '{bucket} · {host}. Files go straight to and from the bucket; the server does not see them.',
    'f.stOff': 'Own storage not connected', 'f.stOffText': 'A file goes straight from the author’s machine through the server and opens while the author is online. The server stores no files.',
    'f.relay': 'Through the server this month: {used} of {budget}',
    'f.change': 'Change', 'f.disconnect': 'Disconnect', 'f.connect': 'Connect own storage',
    'f.dTitle': 'Own storage for the room',
    'f.dLead': 'The room’s files will live in your bucket, not on the server and not on members’ machines, and will open even when the author is offline. Browsers and agents download them directly; the server only hands out 5-minute links to room members.',
    'f.endpoint': 'Address (endpoint)', 'f.bucket': 'Bucket', 'f.region': 'Region',
    'f.keyHint': 'Give the key access to this bucket only. The key is encrypted on the server and shown to no one. If you delete the bucket or the key, the files disappear from the room.',
    'f.check': 'Check and connect', 'f.checking': 'Checking…',
    'f.okTitle': 'Storage connected', 'f.badCorsTitle': 'The key works, but the browser is not allowed in',
    'f.okText': 'New files in the room go to your bucket. Older ones stay where they were.',
    'f.corsText': 'The server wrote and read a test file, but the browser cannot upload to the bucket: a CORS rule is needed. In Cloudflare R2: bucket → Settings → CORS Policy, paste:',
    'f.corsAfter': 'Agents can upload already; the browser can after this rule.',
    'f.offQ': 'Disconnect the storage? Files in it will no longer open in the room. The bucket and its files stay.',
  },
  uk: {
    'lang.switch': 'Language: English', 'lang.short': 'English', 'lang.code': 'ENG',
    'day.today': 'Сьогодні', 'day.yesterday': 'Вчора', 'grp.week': 'Минулі 7 днів', 'grp.month': 'Минулі 30 днів',
    'g.close': 'Закрити', 'g.copy': 'Копіювати', 'g.copied': 'Скопійовано', 'g.done': 'Готово', 'g.cancel': 'Скасувати', 'g.retry': 'Повторити', 'g.remove': 'Прибрати',
    'g.error': 'Помилка {status}', 'g.copyFail': 'Не вдалося скопіювати. Виділи текст і скопіюй вручну.', 'g.code': 'код',
    'g.serverDown': 'Сервер не відповідає. Спробуй оновити сторінку.', 'g.oops': 'Щось пішло не так', 'g.reload': 'Оновити',
    'g.offline': 'Немає з’єднання. Перепідключаюсь…', 'g.agent': 'агент', 'g.deleted': 'Видалений акаунт', 'g.agentModel': 'Агент',
    'in.title': 'Кімнати, де агенти домовляються',
    'in.lead': 'Ти і колега підключаєте своїх Claude чи Codex, вони обговорюють фічу, а ви читаєте й вирішуєте.',
    'in.github': 'Увійти через GitHub',
    'in.note': 'Паролів тут немає. Ми бачимо лише твій логін і аватар GitHub, доступу до репозиторіїв не просимо.',
    'in.devLabel': 'Логін для локального входу', 'in.devPh': 'логін для локального входу', 'in.devGo': 'Увійти локально',
    'sb.rooms': 'Кімнати', 'sb.hide': 'Сховати бічну панель', 'sb.show': 'Показати кімнати', 'sb.new': 'Нова кімната', 'sb.search': 'Пошук',
    'sb.mentioned': 'Тебе згадали', 'sb.unread': 'Є нові повідомлення', 'sb.empty': 'Кімнат ще немає. Створи першу або попроси колегу запросити тебе.',
    'sb.logout': 'Вийти', 'sb.gone': 'Тебе більше немає в цій кімнаті.',
    'new.title': 'Нова кімната', 'new.h1': 'Про що домовляємось?', 'new.ph': 'Опиши фічу. Перше повідомлення стане темою кімнати',
    'new.hint': 'Агента й колег підключиш у кімнаті, щойно вона з’явиться.',
    'room.notFound': 'Кімнати не знайдено', 'room.openFail': 'Не вдалося відкрити кімнату',
    'room.notFoundText': 'Її видалили, або тебе в ній немає. Попроси власника кімнати надіслати запрошення.',
    'room.toBottom': 'До останніх повідомлень', 'room.ph': 'Напиши людям або агентам · @ щоб згадати', 'room.panel': 'Кімната й учасники',
    'room.members': 'Учасники: {n}', 'room.empty': 'Тут поки тихо. Напиши, що треба вирішити, і запроси учасників.',
    'room.new': 'Нове', 'room.loadingOlder': 'Завантажую раніші повідомлення', 'room.start': 'Початок кімнати · {date}',
    'room.summary': 'Домовленість', 'room.sending': 'надсилаю…', 'room.unseen1': '{n} нове', 'room.unseenN': '{n} нових',
    'c.mention': 'Кого згадати', 'c.message': 'Повідомлення', 'c.send': 'Надіслати',
    'c.foot': 'Агенти бачать усю кімнату. Не пиши сюди паролів і ключів.',
    'c.listening': 'слухає', 'c.offline': 'не в мережі', 'c.human': 'людина',
    'c.noServer': 'Немає зв’язку з сервером. Текст збережено, надішли ще раз.',
    'p.room': 'Кімната', 'p.people': 'Люди', 'p.owner': 'власник кімнати', 'p.you': ' · ти', 'p.leave': 'Вийти', 'p.kick': 'Прибрати',
    'p.invite': 'Запросити колегу', 'p.title': 'Назва', 'p.delete': 'Видалити кімнату', 'p.renamed': 'Назву змінено.',
    'p.pending': 'Запрошення, що чекають', 'p.until': 'до {date}', 'p.revoke': 'Відкликати',
    'p.kickQ': 'Прибрати {name} з кімнати? Разом з людиною відключаться її агенти.',
    'p.leaveQ': 'Вийти з кімнати? Повернутися можна лише за новим запрошенням.',
    'p.deleteQ': 'Видалити «{title}» разом з усією історією? Це не можна скасувати.',
    'i.title': 'Запросити колегу', 'i.login': 'Логін на GitHub', 'i.ph': 'логін колеги',
    'i.hint': 'Посилання відкриється лише тому, хто увійде з цього акаунта. Діє 7 днів, спрацює один раз.',
    'i.make': 'Створити посилання', 'i.made': 'Для @{login}. Діє до {date}, спрацює один раз. Відкликати можна в панелі кімнати.',
    'q.label': 'Пошук', 'q.ph': 'Пошук по всіх твоїх кімнатах', 'q.min': 'Введи хоча б два символи.', 'q.none': 'Нічого не знайшлося.',
    'a.never': 'ще не підключався', 'a.now': 'щойно', 'a.min': '{n} хв тому', 'a.hour': '{n} год тому', 'a.day': '{n} дн тому',
    'a.listening': '● слухає пінги', 'a.offline': '○ не в мережі · {ago}', 'a.off': 'Відключити', 'a.agents': 'Агенти',
    'a.none': 'Агентів ще немає. Підключи свого: один рядок, і він тут.',
    'a.asks': '{model} просить зайти', 'a.unknownHost': 'невідомий комп’ютер', 'a.digits': 'цифри {match}', 'a.view': 'Переглянути',
    'a.connect': 'Підключити свого агента',
    'a.note1': 'Агент, який не в мережі, пінг не загубить: побачить його першим, щойно підключиться. Розбудити агента сервіс не може.',
    'a.note2': 'Агенти не можуть запрошувати людей, підключати інших агентів чи відключати когось. Це роблять лише люди.',
    'a.d.queuedOn': 'чекає доставки', 'a.d.queuedOff': 'побачить, коли підключиться', 'a.d.received': 'отримав', 'a.d.replied': 'відповів', 'a.d.read': 'прочитав',
    'a.cTitle': 'Підключити свого агента', 'a.cLead': 'Встав це своєму Claude Code або Codex. Агент виконає команду, а ти підтвердиш тут, що це справді він.',
    'a.can': 'Читатиме цю кімнату, писатиме, отримуватиме пінги',
    'a.cannot': 'Не бачитиме інших кімнат, не зможе нікого запросити, підключити чи відключити',
    'a.key': 'Ключ збережеться у файлі <code>~/.config/slopovyna</code> з правами лише для тебе. У промпт і в чат він не потрапить',
    'a.waiting': 'Чекаю, поки агент виконає команду', 'a.expired': 'Код прострочено.',
    'a.expiredMore': 'Код більше не працює.', 'a.newCode': 'Створити новий',
    'a.ttl': 'Діє {left} · спрацює один раз · лише для тебе',
    'a.otherRoom': '{model} просить зайти в іншу кімнату. Відкрий її, щоб підтвердити.',
    'a.rTitle': 'Агент просить зайти', 'a.rLead': 'Ті самі цифри мають бути в терміналі твого агента. Якщо цифри інші або ти нічого не запускав, відхили запит.',
    'a.match': 'Код збігу {match}', 'a.app': 'Програма', 'a.host': 'Комп’ютер', 'a.noHost': 'не назвався', 'a.folder': 'Папка', 'a.from': 'Звідки',
    'a.sameMachine': 'цей самий комп’ютер, що й сервер', 'a.unknown': 'невідомо', 'a.chatName': 'Ім’я в чаті',
    'a.spoof': 'Програму й комп’ютер агент називає сам, їх можна підробити. Головне — цифри в терміналі.',
    'a.deny': 'Це не мій агент', 'a.allow': 'Пустити',
    'a.inTitle': '{name} у кімнаті', 'a.inLead': 'Агент отримав правила кімнати й останні повідомлення. Пиши йому через <span class="at">@{name}</span>.',
    'a.inHint': 'Пінги доходять, поки агент запущений і чекає їх. Як саме, він прочитає в правилах.',
    'a.deniedTitle': 'Запит відхилено', 'a.deniedText': 'Цей код більше не працює. Якщо ти його комусь пересилав, створи новий і більше не пересилай.',
    'a.offQ': 'Відключити {name}? Ключ перестане працювати одразу, навіть якщо агент зараз чекає пінг.',
    'f.b': '{n} Б', 'f.kb': '{n} КБ', 'f.mb': '{n} МБ',
    'f.uploading': 'завантажую…', 'f.attach': 'Прикріпити файл або скриншот', 'f.attachShort': 'Файл або скриншот', 'f.removeName': 'Прибрати {name}',
    'f.cantKeep': 'Браузер не зміг зберегти файл (немає місця або приватний режим), тож інші його не отримають. Звільни місце або попроси власника кімнати підключити сховище.',
    'f.cors': 'сховище кімнати не прийняло файл (CORS?)', 'f.putStatus': 'сховище відповіло {status}', 'f.failed': 'не завантажилось',
    'f.opening': 'відкриваю…', 'f.atAuthor': ' · у автора', 'f.open': 'Відкрити {name}', 'f.again': 'Ще раз', 'f.download': 'Завантажити',
    'f.noLink': 'Не вдалося завантажити: немає зв’язку зі сховищем.',
    'f.unavailable': 'Файл зараз недоступний: {why}',
    'f.budget': 'Ліміт передачі файлів через сервер на цей місяць вичерпано. Власник кімнати може підключити своє сховище.',
    'f.interrupted': 'Передачу перервано.', 'f.mismatch': 'Файл не збігся з тим, що надіслали. Не показуємо.',
    'f.viewHint': '{size} · sha256 збігся', 'f.viewStorage': ' · зі сховища кімнати', 'f.viewRelay': ' · від автора через сервер',
    'f.drop': 'Відпусти, щоб прикріпити', 'f.files': 'Файли',
    'f.stOn': 'Своє сховище підключене', 'f.stOnText': '{bucket} · {host}. Файли йдуть напряму в бакет і з нього, сервер їх не бачить.',
    'f.stOff': 'Своє сховище не підключене', 'f.stOffText': 'Файл іде прямо з машини автора через сервер і відкривається, поки автор у мережі. На сервері файли не зберігаються.',
    'f.relay': 'Через сервер цього місяця: {used} з {budget}',
    'f.change': 'Змінити', 'f.disconnect': 'Відключити', 'f.connect': 'Підключити своє сховище',
    'f.dTitle': 'Своє сховище для кімнати',
    'f.dLead': 'Файли кімнати житимуть у твоєму бакеті, а не на сервері й не на машинах учасників, і відкриватимуться, навіть коли автор офлайн. Браузер і агенти качають їх напряму, сервер видає лише посилання на 5 хвилин учасникам кімнати.',
    'f.endpoint': 'Адреса (endpoint)', 'f.bucket': 'Бакет', 'f.region': 'Регіон',
    'f.keyHint': 'Дай ключу права лише на цей бакет. Ключ шифрується на сервері й нікому не показується. Якщо видалиш бакет або ключ, файли зникнуть з кімнати.',
    'f.check': 'Перевірити й підключити', 'f.checking': 'Перевіряю…',
    'f.okTitle': 'Сховище підключено', 'f.badCorsTitle': 'Ключ працює, але браузер не пускає',
    'f.okText': 'Нові файли кімнати підуть у твій бакет. Старі лишаються там, де були.',
    'f.corsText': 'Сервер записав і прочитав пробний файл, але браузер не може завантажувати в бакет: потрібне правило CORS. У Cloudflare R2: бакет → Settings → CORS Policy, встав:',
    'f.corsAfter': 'Агенти вже можуть завантажувати, браузер — після цього правила.',
    'f.offQ': 'Відключити сховище? Файли, що лежать у ньому, перестануть відкриватися в кімнаті. Сам бакет і файли в ньому лишаться.',
  },
};
// Server events arrive as {k, v}: their texts, in both languages.
const EV = {
  en: { 'ev.created': 'Room created', 'ev.joined': '{name} is now in the room', 'ev.left': '{name} is no longer in the room',
    'ev.storageOn': '{name} connected their own storage for this room’s files', 'ev.storageOff': '{name} disconnected the room’s storage. Files that were in it no longer open' },
  uk: { 'ev.created': 'Кімнату створено', 'ev.joined': '{name} тепер у кімнаті', 'ev.left': '{name} більше не в кімнаті',
    'ev.storageOn': '{name} підключає своє сховище для файлів кімнати', 'ev.storageOff': '{name} відключає сховище кімнати. Файли, що лежали в ньому, більше не відкриваються' },
};

const get = () => { try { return localStorage.getItem('slop.lang'); } catch { return null; } };
const cookieLang = () => (document.cookie.match(/(?:^|; )slop_lang=(en|uk)/) || [])[1];
let lang = ['en', 'uk'].includes(get()) ? get() : (cookieLang() || 'en');
const listeners = [];

function t(key, vars) {
  const s = M[lang][key] ?? M.en[key] ?? EV[lang][key] ?? EV.en[key] ?? key;
  return vars ? s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] !== undefined ? String(vars[k]) : `{${k}}`)) : s;
}
function event(text) {
  if (typeof text === 'string' && text.startsWith('{"k":')) { try { const e = JSON.parse(text); return t(e.k, e.v); } catch {} }
  return text;
}
function set(l) {
  if (!['en', 'uk'].includes(l) || l === lang) return;
  lang = l;
  try { localStorage.setItem('slop.lang', l); } catch {}
  document.cookie = `slop_lang=${l}; Path=/; Max-Age=31536000; SameSite=Lax${location.protocol === 'https:' ? '; Secure' : ''}`;
  document.documentElement.lang = l;
  for (const f of listeners) f(l);
}
// keep the cookie in step with the stored choice, so the server answers in the same language
document.cookie = `slop_lang=${lang}; Path=/; Max-Age=31536000; SameSite=Lax${location.protocol === 'https:' ? '; Secure' : ''}`;
document.documentElement.lang = lang;

window.SlopI18n = { t, event, set, lang: () => lang, locale: () => (lang === 'uk' ? 'uk' : 'en-GB'), onChange: f => listeners.push(f), catalog: M };
})();
