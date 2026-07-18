#!/usr/bin/env python3
"""
家計簿 MCP Server - FastMCP実装
レシート画像を読み取った生成AIが、家計簿DB(household_budget)へ
明細を登録・確認するためのMCPサーバー
"""
import os
import json
import re
from datetime import date

import asyncpg
from dotenv import load_dotenv
from pydantic import BaseModel, Field
from fastmcp import FastMCP
from fastmcp.server.auth.oidc_proxy import OIDCProxy

# 環境変数の読み込み
load_dotenv()

DB_HOST = os.getenv("DB_HOST")
DB_PORT = int(os.getenv("DB_PORT"))
DB_NAME = os.getenv("DB_NAME")
DB_USER = os.getenv("DB_USER")
DB_PASSWORD = os.getenv("DB_PASSWORD")
MCP_CLIENT_ID = os.getenv("KAKEIBO_MCP_CLIENT_ID")
MCP_CLIENT_SECRET = os.getenv("KAKEIBO_MCP_CLIENT_SECRET")
MCP_BASE_URL = os.getenv("KAKEIBO_MCP_BASE_URL")
OIDC_CONFIG_URL = os.getenv("OIDC_CONFIG_URL")

if not DB_NAME or not DB_USER or not DB_PASSWORD:
    raise ValueError("DB_NAME / DB_USER / DB_PASSWORD environment variables are required")
if not MCP_CLIENT_ID:
    raise ValueError("KAKEIBO_MCP_CLIENT_ID environment variable is required")
if not MCP_CLIENT_SECRET:
    raise ValueError("KAKEIBO_MCP_CLIENT_SECRET environment variable is required")

# Pocket ID を OAuth プロバイダーとして使う OIDC プロキシ認証
# Claude → Pocket ID で OAuth 認証 → MCP サーバーがトークンを JWT 検証
auth = OIDCProxy(
    config_url=OIDC_CONFIG_URL,
    client_id=MCP_CLIENT_ID,
    client_secret=MCP_CLIENT_SECRET,
    base_url=MCP_BASE_URL,
    extra_authorize_params={"scope": "openid profile email"},
    # Pocket ID は RFC 8707 の resource パラメータ未対応のため上流に転送しない
    # (fastmcp 3.4.3+ は既定で転送し、Pocket ID が invalid_request を返す)
    forward_resource=False,
)

# サーバー概要＋全ツール索引＋レシート登録フロー。
# MCP仕様の instructions は initialize レスポンスで接続時に常時参照されるヒント。
SERVER_INSTRUCTIONS = """\
家計簿DB(household_records)を操作するMCPサーバーです。レシート画像から読み取った\
明細の登録と、登録内容の確認・検索ができます。

【データの粒度・書式（重要）】
- 1商品 = 1レコード。同じ商品を2個買ったら2レコード。
- memo = 品名。レシートの略記のままではなく一般的な商品名に可能な限り正規化する。不可能な場合一旦WEB検索も行う\
（例:「Pチップスうすしお」→「ポテトチップス」、「明治オイシイ牛乳1L」→「牛乳」）。
- location = 店名（例: イトーヨーカドー）。
- クーポン・割引はマイナス金額の1レコードで登録（例: memo「クーポン」amount -134）。
- payment_method は通常「現金」（省略時の既定値）。
- category と person はマスターに存在する値のみ登録可能。

【レシート登録の推奨フロー】
1. レシート画像から明細（品名・金額・店名・日付）を抽出し、品名を一般名に正規化する。
2. get_masters でカテゴリ・人の選択肢を取得する。
3. 当該レシートの出費者をユーザーに確認する。
4. search_item_history に品名リストを渡し、過去にその品物がどのカテゴリで\
登録されたかを照会する。ヒットしない品名は、カテゴリ一覧から最も適切なものを判断する\
（迷ったらユーザーに確認）。
5. register_records で全明細を一括登録する。
6. get_records（返却された ids を指定）で登録結果を読み戻し、レシートと突き合わせて検証する。

利用可能なツール一覧（全5種）:

【読み取り系（readOnly / 安全）】
- get_masters: カテゴリ・人のマスター一覧と、支払方法の過去実績を取得。
- search_item_history: 品名（部分一致）ごとに過去のカテゴリ実績と最近の登録例を照会。
- get_records: 登録済みレコードを ids / 日付 / 年月 / 品名キーワード(memo_keyword)で\
検索して取得。登録後の検証や、修正対象の id 特定に使う。

【書き込み系（要注意）】
- register_records: 明細（1商品=1レコード）を一括登録。全件バリデーション後に\
1トランザクションで INSERT し、登録した id のリストを返す。
- update_record: 既存レコード1件を id 指定でピンポイント修正。指定した項目だけを\
書き換える部分更新。誤登録の訂正は get_records（ids / 日付 / memo_keyword）で\
対象の id を特定してからこのツールで直す。修正前後の内容を返すので突き合わせて検証する。

書き込み系ツール（register_records / update_record）は探索結果で下位に沈みやすいが、\
常に利用可能です。ツール名で直接呼び出せます。
"""

# FastMCP インスタンスを作成
mcp = FastMCP("Kakeibo Server", instructions=SERVER_INSTRUCTIONS, auth=auth)


# コネクタURLが /mcp なしで登録された場合の救済: ルートへのMCPリクエストを /mcp へ転送
# (307 はメソッドとボディを保持したままリダイレクトする)
@mcp.custom_route("/", methods=["GET", "POST", "DELETE"])
async def redirect_root_to_mcp(request):
    from starlette.responses import RedirectResponse
    return RedirectResponse(url="/mcp", status_code=307)

# グローバルDBコネクションプール
db_pool: asyncpg.Pool | None = None


async def get_db_pool() -> asyncpg.Pool:
    """DBコネクションプールを取得または作成"""
    global db_pool
    if db_pool is None:
        db_pool = await asyncpg.create_pool(
            host=DB_HOST,
            port=DB_PORT,
            database=DB_NAME,
            user=DB_USER,
            password=DB_PASSWORD,
            min_size=1,
            max_size=5,
            command_timeout=30,
        )
    return db_pool


def to_json(data) -> str:
    return json.dumps(data, indent=2, ensure_ascii=False, default=str)


def escape_like(keyword: str) -> str:
    """ILIKE パターン用に % _ \\ をエスケープ"""
    return re.sub(r"([\\%_])", r"\\\1", keyword)


def parse_record_date(value: str) -> date | None:
    """YYYY-MM-DD 文字列を date に変換（不正なら None）"""
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value or ""):
        return None
    try:
        return date.fromisoformat(value)
    except ValueError:
        return None


# ===== MCP Tools 定義 =====

@mcp.tool(annotations={
    "title": "マスター一覧取得",
    "readOnlyHint": True,
    "openWorldHint": True,
})
async def get_masters() -> str:
    """カテゴリ・人のマスター一覧（登録時に使える値の一覧）と、支払方法の過去実績を取得します。
    register_records の category / person はここで返る値と一致している必要があります。
    同義語: マスター取得 / カテゴリ一覧 / 人一覧 / 選択肢 /
    list masters / categories / persons."""
    pool = await get_db_pool()
    async with pool.acquire() as conn:
        categories = await conn.fetch(
            "SELECT name FROM categories ORDER BY sort_order, name")
        persons = await conn.fetch(
            "SELECT name FROM persons ORDER BY sort_order, name")
        payment_methods = await conn.fetch("""
            SELECT payment_method AS name, COUNT(*)::int AS count
            FROM household_records
            WHERE payment_method IS NOT NULL AND payment_method <> ''
            GROUP BY payment_method ORDER BY count DESC
        """)
    return to_json({
        "categories": [r["name"] for r in categories],
        "persons": [r["name"] for r in persons],
        "payment_methods": [dict(r) for r in payment_methods],
    })


@mcp.tool(annotations={
    "title": "品名の過去カテゴリ実績検索",
    "readOnlyHint": True,
    "openWorldHint": True,
})
async def search_item_history(item_names: list[str], examples_per_item: int = 3) -> str:
    """品名リストを受け取り、各品名について過去レコード（memo の部分一致）を検索して
    「どのカテゴリで登録されてきたか（カテゴリ別件数）」と最近の登録例を返します。
    レシート1枚分の品名をまとめて渡せます。品名はレシート表記ではなく一般名
    （例:「牛乳」「ポテトチップス」）に正規化してから渡すとヒットしやすいです。
    ヒットしない場合は、より短いキーワードで再検索するか、get_masters のカテゴリ一覧から判断してください。
    同義語: カテゴリ検索 / カテゴリ推測 / 過去実績 / 履歴検索 /
    search category / item history / suggest category."""
    pool = await get_db_pool()
    results = []
    async with pool.acquire() as conn:
        for name in item_names:
            keyword = str(name).strip()
            if not keyword:
                continue
            pattern = f"%{escape_like(keyword)}%"
            categories = await conn.fetch("""
                SELECT category, COUNT(*)::int AS count
                FROM household_records
                WHERE memo ILIKE $1
                GROUP BY category ORDER BY count DESC
            """, pattern)
            examples = await conn.fetch("""
                SELECT to_char(record_date, 'YYYY-MM-DD') AS record_date,
                       category, memo, amount, location
                FROM household_records
                WHERE memo ILIKE $1
                ORDER BY record_date DESC, id DESC
                LIMIT $2
            """, pattern, examples_per_item)
            results.append({
                "item_name": keyword,
                "matched": len(categories) > 0,
                "categories": [dict(r) for r in categories],
                "recent_examples": [dict(r) for r in examples],
            })
    return to_json({"results": results})


class RecordInput(BaseModel):
    """household_records への登録1件分（1商品=1レコード）"""
    record_date: str = Field(description="記録日 YYYY-MM-DD（レシートの日付）")
    category: str = Field(description="カテゴリ（get_masters の categories にある値のみ）")
    person: str = Field(description="人（get_masters の persons にある値のみ）")
    amount: int = Field(description="金額（整数円）。クーポン・割引はマイナス値")
    memo: str = Field(default="", description="品名（一般名に正規化。例: ポテトチップス）")
    location: str = Field(default="", description="店名（例: イトーヨーカドー）")
    income_expense: str = Field(default="支出", description="収支区分:「支出」または「収入」")
    payment_method: str = Field(default="現金", description="支払方法（通常は現金）")


@mcp.tool(annotations={
    "title": "家計簿レコード一括登録",
    "readOnlyHint": False,
    "destructiveHint": False,
    "idempotentHint": False,
    "openWorldHint": True,
})
async def register_records(records: list[RecordInput]) -> str:
    """明細（1商品=1レコード）を一括登録します。全件のバリデーションが通った場合のみ
    1トランザクションで INSERT し、登録した id リストを返します（部分登録は発生しません）。
    エラー時は success=false と件別のエラー内容を返すので、修正して再実行してください。
    登録後は get_records（ids 指定）で読み戻して検証してください。
    同義語: 登録 / 追加 / 記帳 / 書き込み / レシート登録 /
    register / insert / add / create records."""
    if not records:
        return to_json({"success": False, "errors": ["records が空です"]})

    pool = await get_db_pool()
    async with pool.acquire() as conn:
        categories = {r["name"] for r in await conn.fetch("SELECT name FROM categories")}
        persons = {r["name"] for r in await conn.fetch("SELECT name FROM persons")}

        # 全件バリデーション（routes/api.js の validateRecord に準拠。
        # 金額のみクーポン等の実データに合わせてマイナス・0も許容）
        errors = []
        rows = []
        for i, rec in enumerate(records):
            prefix = f"records[{i}]"
            record_date = parse_record_date(rec.record_date.strip())
            if record_date is None:
                errors.append(f"{prefix}: 日付が不正です（YYYY-MM-DD）: {rec.record_date!r}")
            if rec.income_expense not in ("支出", "収入"):
                errors.append(f"{prefix}: 収支区分は「支出」または「収入」を指定してください")
            person = rec.person.strip()
            if person not in persons:
                errors.append(f"{prefix}: 人「{person}」はマスターにありません。候補: {sorted(persons)}")
            category = rec.category.strip()
            if category not in categories:
                errors.append(f"{prefix}: カテゴリ「{category}」はマスターにありません。候補: {sorted(categories)}")
            if not (-100000000 <= rec.amount <= 100000000):
                errors.append(f"{prefix}: 金額が範囲外です: {rec.amount}")
            rows.append((
                record_date,
                rec.income_expense,
                rec.payment_method.strip()[:50],
                category,
                person,
                rec.amount,
                rec.location.strip()[:200],
                rec.memo.strip()[:500],
                rec.record_date.strip()[:7],  # year_month
            ))

        if errors:
            return to_json({"success": False, "registered_count": 0, "errors": errors})

        async with conn.transaction():
            ids = []
            for row in rows:
                inserted = await conn.fetchrow("""
                    INSERT INTO household_records
                      (record_date, income_expense, payment_method, category, person,
                       amount, location, memo, year_month)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                    RETURNING id
                """, *row)
                ids.append(inserted["id"])

    total = sum(r.amount for r in records)
    return to_json({
        "success": True,
        "registered_count": len(ids),
        "ids": ids,
        "total_amount": total,
        "hint": "get_records に ids を渡して登録内容を検証してください",
    })


@mcp.tool(annotations={
    "title": "家計簿レコード取得",
    "readOnlyHint": True,
    "openWorldHint": True,
})
async def get_records(
    ids: list[int] | None = None,
    record_date: str = "",
    year_month: str = "",
    memo_keyword: str = "",
    limit: int = 50,
) -> str:
    """登録済みレコードを取得します。ids（register_records の返却値）/
    record_date（YYYY-MM-DD）/ year_month（YYYY-MM）/ memo_keyword（品名の部分一致）で
    絞り込みます（複数指定はAND）。
    登録直後の検証、特定日の明細確認、修正対象レコードの id 特定に使えます。
    同義語: 取得 / 確認 / 検証 / 読み取り / 一覧 / ID検索 /
    get / read / fetch / verify / list / find records."""
    conditions = []
    params = []
    if ids:
        params.append(ids)
        conditions.append(f"id = ANY(${len(params)})")
    if record_date:
        d = parse_record_date(record_date)
        if d is None:
            return to_json({"error": f"record_date が不正です（YYYY-MM-DD）: {record_date!r}"})
        params.append(d)
        conditions.append(f"record_date = ${len(params)}")
    if year_month:
        if not re.fullmatch(r"\d{4}-\d{2}", year_month):
            return to_json({"error": f"year_month が不正です（YYYY-MM）: {year_month!r}"})
        params.append(year_month)
        conditions.append(f"year_month = ${len(params)}")
    if memo_keyword.strip():
        params.append(f"%{escape_like(memo_keyword.strip())}%")
        conditions.append(f"memo ILIKE ${len(params)}")
    if not conditions:
        return to_json({"error": "ids / record_date / year_month / memo_keyword のいずれかを指定してください"})

    limit = max(1, min(int(limit), 500))
    params.append(limit)
    query = f"""
        SELECT id, to_char(record_date, 'YYYY-MM-DD') AS record_date,
               income_expense, payment_method, category, person, amount, location, memo
        FROM household_records
        WHERE {' AND '.join(conditions)}
        ORDER BY record_date DESC, id DESC
        LIMIT ${len(params)}
    """
    pool = await get_db_pool()
    async with pool.acquire() as conn:
        records = await conn.fetch(query, *params)
    return to_json({
        "count": len(records),
        "total_amount": sum(r["amount"] for r in records),
        "records": [dict(r) for r in records],
    })


@mcp.tool(annotations={
    "title": "家計簿レコード修正",
    "readOnlyHint": False,
    "destructiveHint": True,
    "idempotentHint": True,
    "openWorldHint": True,
})
async def update_record(
    id: int,
    record_date: str | None = None,
    category: str | None = None,
    person: str | None = None,
    amount: int | None = None,
    memo: str | None = None,
    location: str | None = None,
    income_expense: str | None = None,
    payment_method: str | None = None,
) -> str:
    """既存レコード1件を id 指定でピンポイント修正します（部分更新）。
    指定した項目だけを書き換え、省略した項目は変更しません。
    対象の id は get_records（ids / record_date / memo_keyword）で特定してください。
    修正前(before)と修正後(after)の内容を返すので、意図どおりか検証してください。
    record_date を変更した場合は year_month も自動で追従します。
    同義語: 修正 / 訂正 / 編集 / 変更 / 更新 /
    update / edit / fix / correct / modify record."""
    pool = await get_db_pool()
    async with pool.acquire() as conn:
        before = await conn.fetchrow("""
            SELECT id, to_char(record_date, 'YYYY-MM-DD') AS record_date,
                   income_expense, payment_method, category, person, amount, location, memo
            FROM household_records WHERE id = $1
        """, id)
        if before is None:
            return to_json({"success": False, "errors": [f"id={id} のレコードが存在しません"]})

        categories = {r["name"] for r in await conn.fetch("SELECT name FROM categories")}
        persons = {r["name"] for r in await conn.fetch("SELECT name FROM persons")}

        # 指定された項目だけバリデーションして更新内容を組み立てる
        errors = []
        updates = {}
        if record_date is not None:
            d = parse_record_date(record_date.strip())
            if d is None:
                errors.append(f"日付が不正です（YYYY-MM-DD）: {record_date!r}")
            else:
                updates["record_date"] = d
                updates["year_month"] = record_date.strip()[:7]
        if income_expense is not None:
            if income_expense not in ("支出", "収入"):
                errors.append("収支区分は「支出」または「収入」を指定してください")
            else:
                updates["income_expense"] = income_expense
        if category is not None:
            if category.strip() not in categories:
                errors.append(f"カテゴリ「{category.strip()}」はマスターにありません。候補: {sorted(categories)}")
            else:
                updates["category"] = category.strip()
        if person is not None:
            if person.strip() not in persons:
                errors.append(f"人「{person.strip()}」はマスターにありません。候補: {sorted(persons)}")
            else:
                updates["person"] = person.strip()
        if amount is not None:
            if not (-100000000 <= amount <= 100000000):
                errors.append(f"金額が範囲外です: {amount}")
            else:
                updates["amount"] = amount
        if memo is not None:
            updates["memo"] = memo.strip()[:500]
        if location is not None:
            updates["location"] = location.strip()[:200]
        if payment_method is not None:
            updates["payment_method"] = payment_method.strip()[:50]

        if errors:
            return to_json({"success": False, "errors": errors, "before": dict(before)})
        if not updates:
            return to_json({"success": False, "errors": ["修正する項目が指定されていません"], "before": dict(before)})

        set_clauses = []
        params = []
        for column, value in updates.items():
            params.append(value)
            set_clauses.append(f"{column} = ${len(params)}")
        params.append(id)
        after = await conn.fetchrow(f"""
            UPDATE household_records SET {', '.join(set_clauses)}
            WHERE id = ${len(params)}
            RETURNING id, to_char(record_date, 'YYYY-MM-DD') AS record_date,
                      income_expense, payment_method, category, person, amount, location, memo
        """, *params)

    return to_json({
        "success": True,
        "updated_fields": sorted(updates.keys()),
        "before": dict(before),
        "after": dict(after),
    })


# FastMCPのHTTPアプリをASGIアプリとしてエクスポート
app = mcp.http_app

if __name__ == "__main__":
    print("Kakeibo MCP Server starting")
    print(f"DB: {DB_HOST}:{DB_PORT}/{DB_NAME}")

    # uvicornで直接起動
    import uvicorn
    uvicorn.run("server:app", host="0.0.0.0", port=3000, reload=False)
