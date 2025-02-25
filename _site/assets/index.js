function titleCase(str) {
	return str.toLowerCase().split(' ').map(function(word) {
		return word.replace(word[0], word[0].toUpperCase());
	}).join(' ');
}
function getParam(name) {
	return (new URLSearchParams(location.search)).get(name)
}
const $ = selector => document.querySelector(selector) 

function today() {
  return (new Date()).toISOString().slice(0,10)
}

const delay = t => new Promise(resolve => setTimeout(resolve, t))

const db = {
  dbName: 'verifyit4.db',
  endpoint: 'https://cw8lr7eknz.g5.sqlite.cloud/v2/weblite',
  apikey: '8EPKxzhZCotKCkO5BTVs3jBtwbHvoo9ObNwG4Pc7J5g',
  async query(sql) {
    try {
      // Optionally, encode the SQL string for safe URL usage
      const formattedSql = encodeURIComponent(sql.replaceAll('\n', ' '));
      const url = `${this.endpoint}/sql?sql=${formattedSql}&database=${this.dbName}&apikey=${this.apikey}`;
      console.log('url', url);
      const resp = await fetch(url);
      if (!resp.ok) {
        throw new Error(`Response status: ${resp.status}`);
      }
      const json = await resp.json();
      return json.data;
    } catch (error) {
      console.error(error.message);
    }
  }
};

