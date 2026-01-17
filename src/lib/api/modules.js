const MODULES_API_BASE = 'https://hbca2f6qck.execute-api.eu-central-1.amazonaws.com/prod/modules';

/**
 * @typedef {Object} ConnectorVersion
 * @property {string} label
 * @property {string} description
 * @property {string} icon
 * @property {string} filename
 */

/**
 * @typedef {Object} Connector
 * @property {string} name
 * @property {string} version
 * @property {string} label
 * @property {string} description
 * @property {string} icon
 */

/**
 * @typedef {Object} Component
 * @property {string} name
 * @property {string} description
 * @property {string} icon
 * @property {boolean} private
 * @property {string} version
 * @property {string} [label]
 */

/**
 * Fetch all connectors from the modules API
 * @returns {Promise<Connector[]>}
 */
export async function fetchAllConnectors() {
  const response = await fetch(`${MODULES_API_BASE}?latest=true`);

  if (!response.ok) {
    throw new Error(`Failed to fetch connectors: ${response.status}`);
  }

  const data = await response.json();

  // Transform the nested object structure to a flat array
  return Object.entries(data).map(([name, versions]) => {
    // Get the first (latest) version
    const versionKey = Object.keys(versions)[0];
    const versionData = versions[versionKey];

    return {
      name,
      version: versionKey,
      label: versionData.label || name.split('.').pop(),
      description: versionData.description || '',
      icon: versionData.icon || ''
    };
  });
}

/**
 * Fetch components for a specific connector version
 * @param {string} connectorName
 * @param {string} version
 * @returns {Promise<Component[]>}
 */
export async function fetchComponentsForConnector(connectorName, version) {
  const response = await fetch(
    `${MODULES_API_BASE}/${connectorName}/components?version=${version}`
  );

  if (!response.ok) {
    // Some connectors might not have components
    if (response.status === 404) {
      return [];
    }
    throw new Error(`Failed to fetch components for ${connectorName}: ${response.status}`);
  }

  const data = await response.json();

  return Object.entries(data).map(([name, details]) => ({
    name,
    description: details.description || '',
    icon: details.icon || '',
    private: details.private || false,
    version: details.version || '1.0.0',
    label: details.label || name.split('.').pop()
  }));
}

/**
 * Fetch all connectors with their components
 * Uses batched parallel fetching with concurrency limit
 * @param {function} [onProgress] - Progress callback
 * @returns {Promise<Array<Connector & {components: Component[]}>>}
 */
export async function fetchAllConnectorsWithComponents(onProgress) {
  const connectors = await fetchAllConnectors();
  const total = connectors.length;
  let completed = 0;

  const BATCH_SIZE = 5; // Limit concurrent requests
  const results = [];

  for (let i = 0; i < connectors.length; i += BATCH_SIZE) {
    const batch = connectors.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map(async (connector) => {
        try {
          const components = await fetchComponentsForConnector(
            connector.name,
            connector.version
          );
          completed++;
          onProgress?.({ completed, total, current: connector.name });
          return { ...connector, components };
        } catch (error) {
          // Log error but continue with empty components
          console.error(`Error fetching components for ${connector.name}:`, error);
          completed++;
          onProgress?.({ completed, total, current: connector.name });
          return { ...connector, components: [] };
        }
      })
    );
    results.push(...batchResults);
  }

  return results;
}
