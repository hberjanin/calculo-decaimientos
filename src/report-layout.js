function fits(page) {
  const content = page.querySelector('.report-columns');
  return [...page.querySelectorAll('.report-column')].every(column => column.scrollHeight <= content.clientHeight + 1);
}

// La estimación inicial mantiene el diseño acordado. Si cambian textos o fuentes,
// medimos el DOM real y redistribuimos sin reducir la letra ni recortar registros.
export function repairReportLayout(container) {
  const pages = [...container.querySelectorAll('.report-page')];
  if (!pages.length) return;
  const stage = document.createElement('div');
  stage.className = 'pdf-capture-stage';
  stage.setAttribute('aria-hidden', 'true');
  document.body.append(stage);
  try {
    let overflow = false;
    for (const source of pages) {
      const clone = source.cloneNode(true);
      stage.replaceChildren(clone);
      if (!fits(clone)) overflow = true;
    }
    if (!overflow) return;
    const output = [];
    for (const category of ['point', 'material']) {
      const sources = pages.filter(page => page.dataset.category === category);
      if (!sources.length) continue;
      const template = sources[0].cloneNode(true);
      template.querySelectorAll('.report-column').forEach(column => column.replaceChildren());
      stage.replaceChildren(template);
      const capacity = template.querySelector('.report-columns').clientHeight - 2;
      const column = template.querySelector('.report-column');
      const gap = parseFloat(getComputedStyle(column).rowGap) || 0;
      const entries = [];
      const measure = node => { column.replaceChildren(node); return node.getBoundingClientRect().height; };
      for (const source of sources.flatMap(page => [...page.querySelectorAll('.report-card')])) {
        const card = source.cloneNode(true);
        if (measure(card) <= capacity) { entries.push({ card, height: measure(card) }); continue; }
        const records = [...card.querySelectorAll('.report-nuclide')];
        card.querySelectorAll('.report-nuclide').forEach(record => record.remove());
        let part = card.cloneNode(true);
        let continued = false;
        const appendPart = () => {
          if (continued) part.querySelector('h3').append(' · continuación');
          entries.push({ card: part, height: measure(part) });
          continued = true;
          part = card.cloneNode(true);
        };
        for (const record of records) {
          part.append(record);
          if (measure(part) > capacity) {
            record.remove();
            if (!part.querySelector('.report-nuclide')) throw new Error('Un registro es demasiado alto para una tarjeta A4. Revisa la longitud de sus textos.');
            appendPart();
            part.append(record);
            if (measure(part) > capacity) throw new Error('Un registro supera el espacio de una columna A4. Revisa sus textos.');
          }
        }
        if (part.querySelector('.report-nuclide')) appendPart();
      }
      column.replaceChildren();
      const columnsNeeded = limit => {
        let count = 1;
        let used = 0;
        for (const entry of entries) {
          if (used && used + gap + entry.height > limit) { count += 1; used = 0; }
          used += (used ? gap : 0) + entry.height;
        }
        return count;
      };
      const pageCount = Math.ceil(columnsNeeded(capacity) / 3);
      const columnCount = Math.min(entries.length, pageCount * 3);
      let lower = Math.max(...entries.map(entry => entry.height));
      let upper = capacity;
      for (let iteration = 0; iteration < 32; iteration += 1) {
        const middle = (lower + upper) / 2;
        if (columnsNeeded(middle) <= columnCount) upper = middle; else lower = middle;
      }
      const columns = [[]];
      let used = 0;
      entries.forEach((entry, index) => {
        const mustLeaveOnePerColumn = entries.length - index === columnCount - columns.length;
        if (used && (used + gap + entry.height > upper + 0.01 || mustLeaveOnePerColumn)) { columns.push([]); used = 0; }
        columns.at(-1).push(entry.card);
        used += (used ? gap : 0) + entry.height;
      });
      for (let index = 0; index < pageCount; index += 1) {
        const page = template.cloneNode(true);
        page.querySelectorAll('.report-column').forEach((target, offset) => target.replaceChildren(...(columns[index * 3 + offset] || [])));
        output.push(page);
      }
    }
    for (const category of ['point', 'material']) {
      const categoryPages = output.filter(page => page.dataset.category === category);
      categoryPages.forEach((page, index) => {
        const title = category === 'point' ? 'Fuentes puntuales' : 'Muestras contaminadas';
        page.querySelector('.report-section-heading h2').textContent = `${title}${index ? ' · continuación' : ''}`;
        page.querySelector('.report-section-heading span').textContent = `En esta página: ${page.querySelectorAll('.report-card').length} tarjetas · sección ${index + 1} de ${categoryPages.length}`;
      });
    }
    output.forEach((page, index) => {
      page.dataset.reportPage = String(index + 1);
      page.querySelector('.report-page-number').textContent = `Página ${index + 1} de ${output.length}`;
    });
    container.querySelector('.report-document').replaceChildren(...output);
  } finally { stage.remove(); }
}
