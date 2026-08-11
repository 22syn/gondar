## 1. אותו באג של `stable`, על `main`

`main` נושא את אותו `DELETE` בלי חסם עליון. Smart עדיין כותב ל-D1, אז הבאג חי בשני הצדדים.

```diff
- sql: 'DELETE FROM fragility_daily WHERE scan_date >= ?',
- params: [rows[0]!.date],
+ sql: 'DELETE FROM fragility_daily WHERE scan_date >= ? AND scan_date <= ?',
+ params: [rows[0]!.date, rows[rows.length - 1]!.date],
```

תזכורת למה: היישור הוא חיתוך על פני 10 מניות הסל. Yahoo הפסיק להחזיר נר אחד בין הריצה של 20:15 לזו של 23:45 ב-2026-08-10, הסדרה התקצרה מ-08-10 ל-08-07, והמחיקה הפתוחה מחקה שורה שלא היה לה תחליף. 264 → 263.

9/9 בדיקות עוברות, כולל בדיקת הרגרסיה שנוספה ב-#142.

## 2. `d1-restore.yml` — כי אין דרך אמיתית לשחזר

זה החלק החשוב יותר.

D1 איבד שורות **פעמיים**: 149→43 ב-`lean_signals` בסוף השבוע, והשורה של 08-10 אתמול. שתיהן ניתנות לשחזור **עקרונית** — ארטיפקטי הסנפשוט מחזיקים payload מלא, ו-`d1-restore.ts` נכתב בדיוק בשביל זה.

**ואי אפשר היה לשחזר אף אחת מהן.** אישורי `CF_*` קיימים רק ב-Actions secrets, ואף workflow לא יכול היה לכתוב. נתיב שחזור שקיים אבל לא ניתן להרצה הוא לא נתיב שחזור.

ה-workflow:
- **ידני בלבד**, `workflow_dispatch`
- מוריד ארטיפקט מריצת snapshot לפי מזהה
- **תמיד מריץ dry-run קודם** — גם כש-`confirm=yes`, כדי שהלוג יתעד את ה-diff שאושר ולא רק את התוצאה
- `confirm` ברירת מחדל `no`, אז ההרצה הטבעית הראשונה מציגה ולא כותבת
- `permissions: contents:read, actions:read` — אין `write` בשום מקום

הבטיחות האמיתית יושבת ב-`d1-restore.ts` שכבר קיים: טבלה אחת ותאריך אחד בהרצה, allowlist של 4 טבלאות, עמודות נקראות מה-payload, וסירוב מוחלט לסנפשוט שמכיל רק hashes.

## שימוש ראשון (השחזור שממתין)

```
source_run_id: 31431800237
table:         fragility_daily
date:          2026-08-10
confirm:       no   → ואז yes
```

🤖 Generated with [Claude Code](https://claude.com/claude-code)
