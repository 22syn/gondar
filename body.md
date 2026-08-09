## הבאג

`d1-snapshot.yml` נכשל בכל הרצה מאז מיזוג #138 — כולל על `main`:

```
failed to parse workflow: (Line: 86, Col: 11): 'retention-days' is already defined,
(Line: 87, Col: 11): 'overwrite' is already defined
```

הבלוק `retention-days: 90` / `overwrite: true` הופיע פעמיים תחת אותו `with:`. GitHub מסרב לפרסר את הקובץ, ולכן גם `workflow_dispatch` וגם ה-`workflow_run` האוטומטי החדש מתו — כלומר הטריגר שנוסף ב-#138 מעולם לא ירה בהצלחה.

## התיקון

הסרת הכפילות. שורה אחת של כל מפתח.

## בדיקה

- `yaml.safe_load` על הקובץ — עובר
- מפתחות תחת `with:` של Upload snapshot: `['name', 'path', 'retention-days', 'overwrite']` — ללא כפילות
- אחרי המיזוג: `gh workflow run` בפועל

## הערה

ההרצה האחרונה שהצליחה (`31339202130`) היא מלפני #138 — היא רצה מול הגרסה התקינה של הקובץ. כל מה שאחריה נכשל, על כל ענף. זה לא היה רעש של Dependabot.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
