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
    { name: 'Auth', description: 'User registration, login and logout.' },
    { name: 'Documents', description: 'Document upload preparation and queries.' },
    { name: 'Admin', description: 'Global operations restricted to the admin role.' },
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
    '/api/auth/logout': {
      post: {
        tags: ['Auth'],
        summary: 'Log out',
        description:
          'Revokes the jti of the bearer token used in this request. The token stops being accepted immediately.',
        security: [{ bearerAuth: [] }],
        responses: {
          '204': { description: 'Token revoked.' },
          '401': {
            description: 'Missing, invalid or already revoked bearer token.',
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
    '/api/admin/documents': {
      get: {
        tags: ['Admin'],
        summary: 'List every document (admin)',
        description:
          'Global view for the admin role: all documents of all users, newest first (in-memory sort), at most 50 items.',
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
          '403': {
            description: 'The authenticated user does not have the admin role.',
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
    '/api/documents/{documentId}/retry': {
      post: {
        tags: ['Documents'],
        summary: 'Retry a failed document',
        description:
          'Owner or admin only. Requeues a FAILED document as PENDING (result/error are cleared) and appends a manual retry audit event. Returns 409 when the document is not FAILED or another retry already claimed it.',
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
            description: 'The document was requeued as PENDING.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['status'],
                  properties: { status: { type: 'string', enum: ['PENDING'] } },
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
            description: 'Document not found, or owned by another user (and not admin).',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Error' },
              },
            },
          },
          '409': {
            description: 'The document is not FAILED, or another retry already claimed it.',
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
      DocumentResult: {
        type: 'object',
        properties: {
          sizeBytes: { type: 'integer' },
          mimeType: { type: 'string' },
          sha256: { type: 'string' },
          pages: { type: 'integer' },
          width: { type: 'integer' },
          height: { type: 'integer' },
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
