// カテゴリ詳細の展開/折りたたみ機能
function toggleDetails(categoryId) {
    const detailRows = document.querySelectorAll(`.detail-${categoryId}`);
    const expandBtn = document.querySelector(`.expand-${categoryId}`);
    
    detailRows.forEach(row => {
        row.classList.toggle('show');
    });
    
    if (expandBtn) {
        expandBtn.classList.toggle('expanded');
    }
}

// タッチデバイス検知
function isTouchDevice() {
    return (('ontouchstart' in window) ||
           (navigator.maxTouchPoints > 0) ||
           (navigator.msMaxTouchPoints > 0));
}

// ページ読み込み完了時の処理
document.addEventListener('DOMContentLoaded', function() {
    // タッチデバイスの場合、hover効果を調整
    if (isTouchDevice()) {
        document.body.classList.add('touch-device');
    }

    // テーブルにスワイプヒントを追加
    const tables = document.querySelectorAll('.table-container');
    tables.forEach(table => {
        table.addEventListener('scroll', function() {
            if (this.scrollLeft > 0) {
                this.classList.add('scrolled');
            } else {
                this.classList.remove('scrolled');
            }
        });
    });
});
