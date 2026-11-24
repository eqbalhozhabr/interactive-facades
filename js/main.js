// Mounts one facade. Which project: index.html#/<id>, otherwise the first project that has a facade.
//   index.html#/armas        (hash, works in an iframe src too)
import { Facade } from './facade.js';

const app = document.getElementById('app');
let facade = null;

async function boot() {
  const config = await (await fetch('projects/projects.json')).json();
  const render = async () => {
    const id = location.hash.replace(/^#\/?/, '');
    const project = config.projects.find((p) => p.id === id && p.facade) ?? config.projects.find((p) => p.facade);
    facade?.destroy();
    app.replaceChildren();
    document.title = `${project.name} - Interactive Facade`;
    facade = new Facade(app, project, config.features);
    await facade.init();
  };
  addEventListener('hashchange', render);
  await render();
}

boot().catch((err) => { app.textContent = `Could not load the facade: ${err.message}`; });
