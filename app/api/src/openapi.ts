/**
 * OpenAPI 3.0 specification for the DocuProcess Cloud REST API.
 * Served as JSON at GET /api/openapi.json and rendered by Swagger UI at /api/docs.
 */
export const openApiSpec = {
  openapi: '3.0.3',
  info: {
    title: 'DocuProcess Cloud API',
    version: '1.0.0',
    description:
      'Authentication with MySQL, bcrypt and JWT, plus document management with DynamoDB and pre-signed S3 URLs.',
  },
  servers: [{ url: '/' }],
  tags: [
    { name: 'Health', description: 'Service and dependency health checks.' },
    { name: 'Auth', description: 'User registration and login.' },
    { name: 'Documents', description: 'Document upload preparation and queries.' },
  ],
  paths: {
    '/api/health': {
      get: {
        tags: ['Health'],
        summary: 'Health check',
        description:
          'Returns 200 without touching MySQL. With deep=1 it also checks MySQL and DynamoDB.',
        parameters: [
          {
            name: 'deep',
            in: 'query',
            required: false,
            description: 'Set to 1, true or yes to check MySQL and DynamoDB.',
            schema: { type: 'string', enum: ['1', 'true', 'yes'] },
          },
        ],
        responses: {
          '200': {
            description: 'Service is healthy.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/HealthResponse' },
              },
            },
          },
          '503': {
            description: 'One or more dependencies are unavailable.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/UnhealthyResponse' },
              },
            },
          },
        },
      },
    },
    '/api/ready': {
      get: {
        tags: ['Health'],
        summary: 'Readiness check',
        description:
          'Runs SELECT 1 against MySQL (network and credentials). Used by the userData at boot; the ALB uses /api/health.',
        responses: {
          '200': {
            description: 'MySQL answers: the instance can serve traffic.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    status: { type: 'string', example: 'ready' },
                    checks: { type: 'object', example: { mysql: 'ok' } },
                  },
                },
              },
            },
          },
          '503': {
            description: 'MySQL does not answer.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/UnhealthyResponse' },
              },
            },
          },
        },
      },
    },
    '/api/auth/register': {
      post: {
        tags: ['Auth'],
        summary: 'Register a new user',
        description:
          'Normalizes the email, hashes the password with bcrypt (cost 12) and stores the user in MySQL.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/RegisterRequest' },
            },
          },
        },
        responses: {
          '201': {
            description: 'User created.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/UserResponse' },
              },
            },
          },
          '400': {
            description: 'Invalid email, weak password or invalid request body.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Error' },
              },
            },
          },
          '409': {
            description: 'The email is already registered.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Error' },
              },
            },
          },
          '503': {
            description: 'MySQL is unavailable.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Error' },
              },
            },
          },
        },
      },
    },
    '/api/auth/login': {
      post: {
        tags: ['Auth'],
        summary: 'Log in',
        description: 'Verifies the password with bcrypt and returns a one-hour HS256 JWT.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/LoginRequest' },
            },
          },
        },
        responses: {
          '200': {
            description: 'Authentication succeeded.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/AuthResponse' },
              },
            },
          },
          '400': {
            description: 'Invalid request body.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Error' },
              },
            },
          },
          '401': {
            description: 'Invalid email or password.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Error' },
              },
            },
          },
          '503': {
            description: 'MySQL is unavailable.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Error' },
              },
            },
          },
        },
      },
    },
    '/api/documents': {
      post: {
        tags: ['Documents'],
        summary: 'Prepare a document upload',
        description:
          'Creates a PENDING item in DynamoDB and returns a pre-signed S3 PUT URL valid for 900 seconds.',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/CreateDocumentRequest' },
            },
          },
        },
        responses: {
          '201': {
            description: 'Upload prepared.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/CreateDocumentResponse' },
              },
            },
          },
          '400': {
            description: 'Invalid filename, content type, size or request body.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Error' },
              },
            },
          },
          '401': {
            description: 'Missing, invalid or expired bearer token.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Error' },
              },
            },
          },
          '413': {
            description: 'Request body exceeds 64 KB.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Error' },
              },
            },
          },
          '503': {
            description: 'S3 or DynamoDB is unavailable.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Error' },
              },
            },
          },
        },
      },
      get: {
        tags: ['Documents'],
        summary: 'List the current user documents',
        description:
          'Queries the userId-createdAt GSI in descending order and returns at most 50 items.',
        security: [{ bearerAuth: [] }],
        responses: {
          '200': {
            description: 'Document list.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['items'],
                  properties: {
                    items: {
                      type: 'array',
                      items: { $ref: '#/components/schemas/Document' },
                    },
                  },
                },
              },
            },
          },
          '401': {
            description: 'Missing, invalid or expired bearer token.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Error' },
              },
            },
          },
          '503': {
            description: 'DynamoDB is unavailable.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Error' },
              },
            },
          },
        },
      },
    },
    '/api/documents/{documentId}': {
      get: {
        tags: ['Documents'],
        summary: 'Get a document by ID',
        description:
          'Returns 404 when the document does not exist or belongs to another user.',
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: 'documentId',
            in: 'path',
            required: true,
            description: 'Document UUID v4.',
            schema: { type: 'string', format: 'uuid' },
          },
        ],
        responses: {
          '200': {
            description: 'Document found.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Document' },
              },
            },
          },
          '401': {
            description: 'Missing, invalid or expired bearer token.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Error' },
              },
            },
          },
          '404': {
            description: 'Document not found or owned by another user.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Error' },
              },
            },
          },
          '503': {
            description: 'DynamoDB is unavailable.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Error' },
              },
            },
          },
        },
      },
    },
    // Bitácora auditable: 404 (no 403) para documento ajeno o inexistente, para no revelar si
    // el documentId existe. El orden es cronológico ascendente, como un log de eventos.
    '/api/documents/{documentId}/events': {
      get: {
        tags: ['Documents'],
        summary: 'Get the audit trail of a document',
        description:
          'Queries document_events in ascending order and returns the state transitions (append-only audit log). Returns 404 when the document does not exist or belongs to another user.',
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: 'documentId',
            in: 'path',
            required: true,
            description: 'Document UUID v4.',
            schema: { type: 'string', format: 'uuid' },
          },
        ],
        responses: {
          '200': {
            description: 'Chronological audit trail (at most 200 events).',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['items'],
                  properties: {
                    items: {
                      type: 'array',
                      items: { $ref: '#/components/schemas/DocumentEvent' },
                    },
                  },
                },
              },
            },
          },
          '401': {
            description: 'Missing, invalid or expired bearer token.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Error' },
              },
            },
          },
          '404': {
            description: 'Document not found or owned by another user.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Error' },
              },
            },
          },
          '503': {
            description: 'DynamoDB is unavailable.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Error' },
              },
            },
          },
        },
      },
    },
    // URL temporal de lectura para la vista previa embebida del frontend.
    '/api/documents/{documentId}/download': {
      get: {
        tags: ['Documents'],
        summary: 'Get a presigned URL to preview a processed document',
        description:
          'Validates ownership and returns a short-lived presigned S3 GET URL with inline Content-Disposition. Only DONE documents can be previewed.',
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: 'documentId',
            in: 'path',
            required: true,
            description: 'Document UUID v4.',
            schema: { type: 'string', format: 'uuid' },
          },
        ],
        responses: {
          '200': {
            description: 'Presigned preview URL.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/PreviewResponse' },
              },
            },
          },
          '401': {
            description: 'Missing, invalid or expired bearer token.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Error' },
              },
            },
          },
          '404': {
            description: 'Document not found or owned by another user.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Error' },
              },
            },
          },
          '409': {
            description: 'Document is not DONE yet.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Error' },
              },
            },
          },
          '503': {
            description: 'DynamoDB or S3 is unavailable.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Error' },
              },
            },
          },
        },
      },
    },
  },
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
      },
    },
    schemas: {
      Error: {
        type: 'object',
        required: ['error', 'message'],
        properties: {
          error: { type: 'string', example: 'invalid_request' },
          message: { type: 'string', example: 'El cuerpo debe ser un objeto JSON.' },
        },
      },
      HealthResponse: {
        type: 'object',
        required: ['status'],
        properties: {
          status: { type: 'string', example: 'ok' },
          checks: {
            type: 'object',
            additionalProperties: { type: 'string' },
            example: { mysql: 'ok', dynamodb: 'ok' },
          },
        },
      },
      UnhealthyResponse: {
        type: 'object',
        required: ['error', 'message', 'checks'],
        properties: {
          error: { type: 'string', example: 'unhealthy' },
          message: {
            type: 'string',
            example: 'Una o mas dependencias no responden.',
          },
          checks: {
            type: 'object',
            additionalProperties: { type: 'string' },
            example: { mysql: 'error', dynamodb: 'ok' },
          },
        },
      },
      RegisterRequest: {
        type: 'object',
        required: ['email', 'password'],
        properties: {
          email: { type: 'string', format: 'email', maxLength: 255 },
          password: {
            type: 'string',
            minLength: 8,
            description: 'At most 72 UTF-8 bytes (bcrypt limit).',
          },
        },
      },
      LoginRequest: {
        type: 'object',
        required: ['email', 'password'],
        properties: {
          email: { type: 'string', format: 'email' },
          password: { type: 'string' },
        },
      },
      UserResponse: {
        type: 'object',
        required: ['id', 'email'],
        properties: {
          id: { type: 'integer', example: 1 },
          email: { type: 'string', format: 'email', example: 'user@example.com' },
        },
      },
      AuthResponse: {
        type: 'object',
        required: ['token', 'expiresIn'],
        properties: {
          token: { type: 'string', description: 'HS256 JWT bearer token.' },
          expiresIn: { type: 'integer', example: 3600 },
        },
      },
      CreateDocumentRequest: {
        type: 'object',
        required: ['filename', 'contentType', 'size'],
        properties: {
          filename: { type: 'string', example: 'report.pdf' },
          contentType: {
            type: 'string',
            enum: ['application/pdf', 'image/png', 'image/jpeg', 'text/plain'],
          },
          size: {
            type: 'integer',
            minimum: 1,
            maximum: 10485760,
            example: 12345,
          },
        },
      },
      CreateDocumentResponse: {
        type: 'object',
        required: [
          'documentId',
          'uploadUrl',
          'method',
          'headers',
          'key',
          'expiresIn',
        ],
        properties: {
          documentId: { type: 'string', format: 'uuid' },
          uploadUrl: { type: 'string', format: 'uri' },
          method: { type: 'string', enum: ['PUT'] },
          headers: {
            type: 'object',
            required: ['Content-Type'],
            properties: {
              'Content-Type': { type: 'string' },
            },
          },
          key: { type: 'string', example: 'uploads/1/<uuid>/report.pdf' },
          expiresIn: { type: 'integer', example: 900 },
        },
      },
      PreviewResponse: {
        type: 'object',
        required: ['url', 'expiresIn', 'method', 'filename', 'contentType'],
        properties: {
          url: { type: 'string', format: 'uri' },
          expiresIn: { type: 'integer', example: 900 },
          method: { type: 'string', enum: ['GET'] },
          filename: { type: 'string' },
          contentType: { type: 'string' },
        },
      },
      DocumentResult: {
        type: 'object',
        properties: {
          sizeBytes: { type: 'integer' },
          mimeType: { type: 'string' },
          sha256: { type: 'string' },
          sha1: { type: 'string' },
          md5: { type: 'string' },
          pages: { type: 'integer' },
          width: { type: 'integer' },
          height: { type: 'integer' },
          summary: {
            type: 'string',
            description:
              'Extractive summary of the document text (TXT and PDFs with selectable text).',
          },
          metadataVersion: { type: 'integer', example: 3 },
          processedAt: { type: 'string', format: 'date-time' },
          processingMs: { type: 'integer' },
          metadataTruncated: {
            type: 'boolean',
            description: 'True when metadata was trimmed to fit DynamoDB limits.',
          },
          metadata: {
            type: 'object',
            additionalProperties: true,
            properties: {
              file: {
                type: 'object',
                additionalProperties: true,
                properties: {
                  extension: { type: 'string' },
                  sizeBytes: { type: 'integer' },
                  mimeType: { type: 'string' },
                  sha256: { type: 'string' },
                  sha1: { type: 'string' },
                  md5: { type: 'string' },
                },
              },
              pdf: {
                type: 'object',
                additionalProperties: true,
                properties: {
                  version: { type: 'string', example: '1.7' },
                  pages: { type: 'integer' },
                  pageSizes: { type: 'array', items: { type: 'object' } },
                  uniformPageSize: { type: 'object' },
                  title: { type: 'string' },
                  author: { type: 'string' },
                  subject: { type: 'string' },
                  keywords: { type: 'array', items: { type: 'string' } },
                  creator: { type: 'string' },
                  producer: { type: 'string' },
                  creationDate: { type: 'string', format: 'date-time' },
                  modificationDate: { type: 'string', format: 'date-time' },
                  encrypted: { type: 'boolean' },
                  hasForm: { type: 'boolean' },
                  linearized: { type: 'boolean' },
                },
              },
              image: {
                type: 'object',
                additionalProperties: true,
                properties: {
                  format: { type: 'string', example: 'JPEG' },
                  width: { type: 'integer' },
                  height: { type: 'integer' },
                  aspectRatio: { type: 'number' },
                  megapixels: { type: 'number' },
                  colorType: { type: 'string' },
                  bitDepth: { type: 'integer' },
                  hasAlpha: { type: 'boolean' },
                  interlaced: { type: 'boolean' },
                  dpi: { type: 'integer' },
                  textChunks: { type: 'array', items: { type: 'object' } },
                  gamma: { type: 'number', description: 'Gamma del archivo PNG (chunk gAMA).' },
                  srgbIntent: { type: 'integer', description: 'Intención de renderizado sRGB (chunk sRGB).' },
                  hasIccProfile: { type: 'boolean', description: 'True si el PNG tiene perfil ICC embebido (chunk iCCP).' },
                  compressionMethod: { type: 'integer', description: 'Método de compresión PNG (IHDR).' },
                  filterMethod: { type: 'integer', description: 'Método de filtro PNG (IHDR).' },
                  lastModified: { type: 'string', description: 'Marca de tiempo del archivo (chunk tIME).' },
                  backgroundColor: { type: 'string', description: 'Color de fondo (chunk bKGD).' },
                  exif: { type: 'object', additionalProperties: true },
                  gps: {
                    type: 'object',
                    properties: {
                      latitude: { type: 'number' },
                      longitude: { type: 'number' },
                      altitude: { type: 'number' },
                      dop: { type: 'number', description: 'Precisión de la posición (DOP).' },
                      speed: { type: 'number', description: 'Velocidad en m/s.' },
                      imgDirection: { type: 'number', description: 'Dirección de la imagen en grados.' },
                      timestamp: { type: 'string', description: 'Sello de tiempo GPS combinado (fecha + hora).' },
                      processingMethod: { type: 'string', description: 'Método de procesamiento GPS.' },
                    },
                  },
                },
              },
              text: {
                type: 'object',
                additionalProperties: true,
                properties: {
                  source: { type: 'string', enum: ['txt', 'pdf'] },
                  encoding: { type: 'string' },
                  bom: { type: 'boolean' },
                  newline: { type: 'string', enum: ['LF', 'CRLF', 'CR'] },
                  lines: { type: 'integer' },
                  words: { type: 'integer' },
                  characters: { type: 'integer' },
                  paragraphs: { type: 'integer' },
                  pagesAnalyzed: { type: 'integer' },
                  truncated: { type: 'boolean' },
                  preview: { type: 'string' },
                  uniqueWords: { type: 'integer', description: 'Palabras únicas (aproximación).' },
                  avgWordsPerSentence: { type: 'number', description: 'Media de palabras por oración.' },
                  avgSentenceLength: { type: 'number', description: 'Longitud media de frase en caracteres.' },
                  language: { type: 'string', description: "Idioma estimado ('es' | 'en' | 'mixed')." },
                },
              },
              source: {
                type: 'object',
                additionalProperties: true,
                properties: {
                  eTag: { type: 'string' },
                  versionId: { type: 'string' },
                  storageClass: { type: 'string' },
                  serverSideEncryption: { type: 'string' },
                  lastModified: { type: 'string', format: 'date-time' },
                  key: { type: 'string', description: 'Clave S3 completa (bucket + ruta).' },
                  declaredMimeType: { type: 'string', description: 'MIME declarado por el cliente al subir.' },
                  mimeMismatch: { type: 'boolean', description: 'True si el MIME declarado difiere del detectado.' },
                },
              },
            },
          },
        },
      },
      Document: {
        type: 'object',
        required: [
          'documentId',
          'userId',
          'filename',
          'contentType',
          's3Key',
          'status',
          'createdAt',
          'updatedAt',
        ],
        properties: {
          documentId: { type: 'string', format: 'uuid' },
          userId: { type: 'string' },
          filename: { type: 'string' },
          contentType: { type: 'string' },
          s3Key: { type: 'string' },
          status: {
            type: 'string',
            enum: ['PENDING', 'PROCESSING', 'DONE', 'FAILED'],
          },
          createdAt: {
            type: 'string',
            format: 'date-time',
            example: '2026-11-05T14:03:22.123Z',
          },
          updatedAt: {
            type: 'string',
            format: 'date-time',
            example: '2026-11-05T14:03:22.123Z',
          },
          result: { $ref: '#/components/schemas/DocumentResult' },
          error: { type: 'string' },
        },
      },
      // Espejo de app/api/src/types.ts (DocumentEvent): la API nunca escribe actualizaciones
      // sobre este esquema; un cambio de formato implica schemaVersion +1.
      DocumentEvent: {
        type: 'object',
        required: [
          'documentId',
          'eventAt',
          'eventId',
          'userId',
          'eventDay',
          'toStatus',
          'actor',
          'schemaVersion',
        ],
        properties: {
          documentId: { type: 'string', format: 'uuid' },
          eventAt: {
            type: 'string',
            example: '2026-11-11T14:00:02.400Z#a1b2c3',
            description: 'Sort key: ISO-8601 UTC with milliseconds plus a random suffix.',
          },
          eventId: { type: 'string', format: 'uuid' },
          userId: { type: 'string' },
          eventDay: { type: 'string', example: '2026-11-11' },
          fromStatus: {
            type: 'string',
            enum: ['PENDING', 'PROCESSING', 'DONE', 'FAILED'],
            description: 'Absent on the creation event.',
          },
          toStatus: {
            type: 'string',
            enum: ['PENDING', 'PROCESSING', 'DONE', 'FAILED'],
          },
          actor: { type: 'string', enum: ['api', 'worker', 'system'] },
          reason: { type: 'string' },
          error: { type: 'string' },
          requestId: { type: 'string' },
          schemaVersion: { type: 'integer', example: 1 },
        },
      },
    },
  },
};
