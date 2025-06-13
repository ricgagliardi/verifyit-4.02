import vento from "jsr:@vento/vento";
import { DatabaseSync } from "node:sqlite";

// Error handling for config loading
let config;
try {
  config = JSON.parse(await Deno.readTextFile('./config.json'));
} catch (error) {
  console.error("Failed to load configuration:", error);
  Deno.exit(1); // Exit with error code since the server can't run without config
}

// Database connection with error handling
let db;
try {
  db = new DatabaseSync(config.dbPath);
} catch (error) {
  console.error(`Failed to connect to database at ${config.dbPath}:`, error);
  Deno.exit(1); // Exit with error code since the server can't run without DB
}

// Initialize template engine
const env = vento({includes: './view'});
const wsClients = {};

/**
 * Parse URL parameters with type conversion and validation
 * @param {URL} url - The request URL
 * @returns {Object} - Parsed parameters
 */
async function gatherParams(req) {
  function parseParam(v) {
    if (v === "") { return true; }
    else if (v === "true") { return true; } 
    else if (v === "false") { return false; }
    else if (!isNaN(Number(v))) { return +v; }
    return v;
  }
  const url = new URL(req.url)
  const params = {};
  for (const [key, value] of url.searchParams) {
    params[key] = parseParam(value);
  }
	if (req.body) {
		params._body = {}
		const body = await req.formData()
		for (const [key, value] of body) {
			params._body[key] = value
		}
	}
  return params;
}

/**
 * Handle WebSocket connection upgrades with proper error management
 * @param {Request} req - The HTTP request
 * @param {Object} params - Request parameters
 * @returns {Response} - WebSocket upgrade response
 */
function prepWebSocket(req, params) {
  try {
    // Validate required WebSocket parameters
    if (!params.username) {
      return new Response("WebSocket connection requires a username parameter", { 
        status: 400 
      });
    }

    const { socket, response } = Deno.upgradeWebSocket(req);

    socket.onopen = () => {
      try {
        socket.username = params.username || 'anonymous';
        socket.channels = params.channels ? params.channels.split(/\s*,\s*/) : [];
        socket.sources = params.sources ? params.sources.split(/\s*,\s*/) : [];
        wsClients[socket.username] = socket;
        console.log("CONNECTED", socket.username, socket.channels, socket.sources, Object.keys(wsClients));
      } catch (error) {
        console.error("Error in WebSocket onopen handler:", error);
        socket.close(1011, "Server error during connection setup");
      }
    };
    socket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          data.source = socket.username;
          data.channel=params.channels
          console.log('RECEIVED: ', event.data);
          
          Object.values(wsClients).forEach(client => {
            
            if (client.username !== socket.username && client.readyState === 1) { // Check if socket is OPEN
              console.log(' checking source', data.source, 'channel', data.channel);
              console.log(' client sources', client.sources, 'channels', client.channels);
              
              if (client.sources.includes(data.source) || client.channels.includes(data.channel)) {
                console.log(' matched. sending to ', client.username, client.channels);
                try {
                  client.send(JSON.stringify(data));
                } catch (sendError) {
                  console.error(`Error sending to client ${client.username}:`, sendError);
                }
              } else {
                console.log(' no match.');
              }
            }
          });
        } catch (error) {
          console.error("Error processing WebSocket message:", error);
          // Don't close the socket on message processing errors - just log them
        }
      };
    
    socket.onclose = (event) => {
      delete wsClients[socket.username];
      console.log("DISCONNECTED", socket.username, Object.keys(wsClients), `Code: ${event.code}, Reason: ${event.reason}`);
    };
    
    socket.onerror = (error) => {
      console.error("WebSocket ERROR for user", socket.username, ":", error);
    };

    return response;
  } catch (error) {
    console.error("Failed to upgrade to WebSocket:", error);
    return new Response("Failed to establish WebSocket connection: " + error.message, { 
      status: 500 
    });
  }
}

/**
 * Map HTTP status codes to appropriate errors
 * @param {Error} error - The caught error
 * @returns {Object} - HTTP status and message
 */
function mapErrorToHttpResponse(error) {
  if (error.name === "NotFound" || error instanceof Deno.errors.NotFound) {
    return { status: 404, message: "Not Found" };
  } else if (error.name === "PermissionDenied" || error instanceof Deno.errors.PermissionDenied) {
    return { status: 403, message: "Permission Denied" };
  } else if (error.name === "ConnectionRefused" || error instanceof Deno.errors.ConnectionRefused) {
    return { status: 503, message: "Service Unavailable" };
  } else if (error.name === "BadResource" || error instanceof Deno.errors.BadResource) {
    return { status: 400, message: "Bad Request" };
  } else if (error.name === "Interrupted" || error instanceof Deno.errors.Interrupted) {
    return { status: 500, message: "Server Operation Interrupted" };
  } else {
    return { status: 500, message: "Internal Server Error" };
  }
}

/**
 * Main request handler with comprehensive error handling
 * @param {Request} req - The HTTP request
 * @returns {Response} - The HTTP response
 */
async function handleReq(req) {
  try {
    const url = new URL(req.url);
    const filepath = url.pathname === "/" ? '/index' : 
      url.pathname == '/favicon.ico' ? '/assets/logo.png' :
      decodeURIComponent(url.pathname);

    const params = await gatherParams(req)
    console.log(req.method, filepath, params);

    // WebSocket upgrade handling
    if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      return prepWebSocket(req, params);
    }

    if (url.pathname === "/page1.html") {
      try {
        const file = await Deno.readTextFile("./page1.html");
        return new Response(file, {
          status: 200,
          headers: {
            "Content-Type": "text/html",
          }
        });
      } catch (error) {
        console.error(`Error serving index.html:`, error);
        return new Response("404 Not Found", { status: 404 });
      }
    }

    if (url.pathname === "/page2.html") {
      try {
        const file = await Deno.readTextFile("./page2.html");
        return new Response(file, {
          status: 200,
          headers: {
            "Content-Type": "text/html",
          }
        });
      } catch (error) {
        console.error(`Error serving index.html:`, error);
        return new Response("404 Not Found", { status: 404 });
      }
    }

    // Static file serving
    if (filepath.startsWith('/assets/')) {
      try {
        const file = await Deno.open("." + filepath, { read: true });
        
        // Determine content type based on file extension
        const contentType = getContentType(filepath);
        
        return new Response(file.readable, {
          status: 200,
          headers: {
            "Content-Type": contentType,
          }
        });
      } catch (error) {
        console.error(`Error serving static file ${filepath}:`, error);
        const { status, message } = mapErrorToHttpResponse(error);
        
        return new Response(`${status} ${message}: ${filepath}`, { 
          status: status,
          headers: { "Content-Type": "text/plain" }
        });
      }
    }
    
    // Template rendering
    try {
      // Protect against database errors within template rendering
      const result = await env.run(`./view${filepath}.vto`, {
        db, 
        params,
        config: config.public
      });

			return new Response(result.content, {
        status: 200,
        headers: {
          "Content-Type": "text/html",
        }
      });
    } catch (error) {
      console.error(`Error rendering template ${filepath}:`, error);
      
      // Specific error handling for template errors
      if (error.message?.includes("not found") || error.code === "ENOENT") {
        return new Response(`404 Not Found: ${filepath}`, { 
          status: 404,
          headers: { "Content-Type": "text/plain" }
        });
      }
      
      // For other template errors, return a 500 with details
      return new Response(`500 Server Error: Error processing ${filepath}: ${error.message}`, { 
        status: 500,
        headers: { "Content-Type": "text/plain" }
      });
    }
  } catch (error) {
    // Catch-all for unexpected errors in the request handling
    console.error("Unhandled server error:", error);
    return new Response("500 Internal Server Error", { 
      status: 500,
      headers: { "Content-Type": "text/plain" }
    });
  }
}

/**
 * Determine content type based on file extension
 * @param {string} filepath - Path of the file
 * @returns {string} - MIME type
 */
function getContentType(filepath) {
  const extension = filepath.split('.').pop()?.toLowerCase();
  const mimeTypes = {
    'html': 'text/html',
    'css': 'text/css',
    'js': 'application/javascript',
    'json': 'application/json',
    'png': 'image/png',
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'gif': 'image/gif',
    'svg': 'image/svg+xml',
    'ico': 'image/x-icon',
    'txt': 'text/plain',
    'pdf': 'application/pdf'
  };

  return mimeTypes[extension] || 'application/octet-stream';
}

// Server startup with error handling
console.log('Starting server in', config.public.stage.toLowerCase(), 'mode');

try {
  if (config.public.stage.toLowerCase() === 'production') {
    try {
      const cert = await Deno.readTextFile(config.certs.cert);
      const key = await Deno.readTextFile(config.certs.key);
      
      Deno.serve({
        cert, 
        key, 
        port: 443,
        onListen: ({ hostname, port }) => {
          console.log(`HTTPS server running on https://${hostname || 'localhost'}:${port}/`);
        },
        onError: (error) => {
          console.error("Server error:", error);
          return new Response("500 Internal Server Error", { status: 500 });
        }
      }, handleReq);
    } catch (error) {
      console.error("Failed to start HTTPS server:", error);
      console.error("Check your certificate configuration in config.json");
      Deno.exit(1);
    }
  } else {
    Deno.serve({
      port: 3000,
      onListen: ({ hostname, port }) => {
        console.log(`HTTP server running on http://${hostname || 'localhost'}:${port}/`);
      },
      onError: (error) => {
        console.error("Server error:", error);
        return new Response("500 Internal Server Error", { status: 500 });
      }
    }, handleReq);
  }
} catch (error) {
  console.error("Critical server error:", error);
  Deno.exit(1);
}