import fs from "fs";
import path from "path";
import { prettyPrint } from "recast";
import astTypes, { Type } from "../main";

const Op = Object.prototype;
const hasOwn = Op.hasOwnProperty;

const { builders: b, namedTypes: n, getBuilderName } = astTypes;

const RESERVED_WORDS: { [reservedWord: string]: boolean | undefined } = {
  extends: true,
  default: true,
  arguments: true,
  static: true,
};

const NODES_ID = b.identifier("N");
const NODES_IMPORT = b.importDeclaration(
  [b.importNamespaceSpecifier(NODES_ID)],
  b.stringLiteral("./nodes")
);

const KINDS_ID = b.identifier("K");
const KINDS_IMPORT = b.importDeclaration(
  [b.importNamespaceSpecifier(KINDS_ID)],
  b.stringLiteral("./kinds")
);

const supertypeToSubtypes = getSupertypeToSubtypes();
const builderTypeNames = getBuilderTypeNames();

const out = [
  {
    file: "kinds.ts",
    ast: moduleWithBody([
      NODES_IMPORT,
      ...Object.keys(supertypeToSubtypes).map(baseName => {
        return b.exportNamedDeclaration(
          b.tsTypeAliasDeclaration(
            b.identifier(`${baseName}Kind`),
            b.tsUnionType(
              supertypeToSubtypes[baseName].map(subtypeName =>
                b.tsTypeReference(b.tsQualifiedName(NODES_ID, b.identifier(subtypeName)))
              )
            )
          )
        );
      }),
    ]),
  },
  {
    file: "nodes.ts",
    ast: moduleWithBody([
      b.importDeclaration([b.importSpecifier(b.identifier("Omit"))], b.stringLiteral("../types")),
      KINDS_IMPORT,
      ...Object.keys(astTypes.namedTypes).map(typeName => {
        const typeDef = astTypes.Type.def(typeName);
        const ownFieldNames = Object.keys(typeDef.ownFields);

        return b.exportNamedDeclaration(
          b.tsInterfaceDeclaration.from({
            id: b.identifier(typeName),
            extends: typeDef.baseNames.map(baseName => {
              const baseDef = astTypes.Type.def(baseName);
              const commonFieldNames = ownFieldNames
                .filter(fieldName => !!baseDef.allFields[fieldName]);

              if (commonFieldNames.length > 0) {
                return b.tsExpressionWithTypeArguments(
                  b.identifier("Omit"),
                  b.tsTypeParameterInstantiation([
                    b.tsTypeReference(b.identifier(baseName)),
                    b.tsUnionType(
                      commonFieldNames.map(fieldName => 
                        b.tsLiteralType(b.stringLiteral(fieldName))
                      )
                    ),
                  ])
                );
              } else {
                return b.tsExpressionWithTypeArguments(b.identifier(baseName));
              }
            }),
            body: b.tsInterfaceBody(
              ownFieldNames.map(fieldName => {
                const field = typeDef.allFields[fieldName];

                if (field.name === "type" && field.defaultFn) {
                  return b.tsPropertySignature(
                    b.identifier("type"),
                    b.tsTypeAnnotation(b.tsLiteralType(b.stringLiteral(field.defaultFn())))
                  );
                }

                return b.tsPropertySignature(
                  b.identifier(field.name),
                  b.tsTypeAnnotation(getTSTypeAnnotation(field.type))
                );
              })
            ),
          })
        );
      }),
    ]),
  },
  {
    file: "namedTypes.ts",
    ast: moduleWithBody([
      b.importDeclaration(
        [b.importSpecifier(b.identifier("Type"))],
        b.stringLiteral("../lib/types")
      ),
      NODES_IMPORT,
      b.exportNamedDeclaration(
        b.tsInterfaceDeclaration(
          b.identifier("NamedTypes"),
          b.tsInterfaceBody(
            Object.keys(astTypes.namedTypes).map(typeName =>
              b.tsPropertySignature(
                b.identifier(typeName),
                b.tsTypeAnnotation(
                  b.tsTypeReference(
                    b.identifier("Type"),
                    b.tsTypeParameterInstantiation([
                      b.tsTypeReference(b.tsQualifiedName(NODES_ID, b.identifier(typeName))),
                    ])
                  )
                )
              )
            )
          )
        )
      ),
    ]),
  },
  {
    file: "builders.ts",
    ast: moduleWithBody([
      KINDS_IMPORT,
      NODES_IMPORT,
      ...builderTypeNames.map(typeName => {
        const typeDef = astTypes.Type.def(typeName);

        const returnType = b.tsTypeAnnotation(
          b.tsTypeReference(b.tsQualifiedName(NODES_ID, b.identifier(typeName)))
        );

        const buildParamAllowsUndefined: { [buildParam: string]: boolean } = {};
        const buildParamIsOptional: { [buildParam: string]: boolean } = {};
        [...typeDef.buildParams].reverse().forEach((cur, i, arr) => {
          const field = typeDef.allFields[cur];
          if (field && field.defaultFn) {
            if (i === 0) {
              buildParamIsOptional[cur] = true;
            } else {
              if (buildParamIsOptional[arr[i - 1]]) {
                buildParamIsOptional[cur] = true;
              } else {
                buildParamAllowsUndefined[cur] = true;
              }
            }
          }
        });

        return b.exportNamedDeclaration(
          b.tsInterfaceDeclaration(
            b.identifier(`${typeName}Builder`),
            b.tsInterfaceBody([
              b.tsCallSignatureDeclaration(
                typeDef.buildParams
                  .filter(buildParam => !!typeDef.allFields[buildParam])
                  .map(buildParam => {
                    const field = typeDef.allFields[buildParam];
                    const name = RESERVED_WORDS[buildParam] ? `${buildParam}Param` : buildParam;

                    return b.identifier.from({
                      name,
                      typeAnnotation: b.tsTypeAnnotation(
                        !!buildParamAllowsUndefined[buildParam]
                          ? b.tsUnionType([getTSTypeAnnotation(field.type), b.tsUndefinedKeyword()])
                          : getTSTypeAnnotation(field.type)
                      ),
                      optional: !!buildParamIsOptional[buildParam],
                    });
                  }),
                returnType
              ),
              b.tsMethodSignature(
                b.identifier("from"),
                [
                  b.identifier.from({
                    name: "params",
                    typeAnnotation: b.tsTypeAnnotation(
                      b.tsTypeLiteral(
                        Object.keys(typeDef.allFields)
                          .filter(fieldName => fieldName !== "type")
                          .sort() // Sort field name strings lexicographically.
                          .map(fieldName => {
                            const field = typeDef.allFields[fieldName];
                            return b.tsPropertySignature(
                              b.identifier(field.name),
                              b.tsTypeAnnotation(getTSTypeAnnotation(field.type)),
                              field.defaultFn != null || field.hidden
                            );
                          })
                      )
                    ),
                  }),
                ],
                returnType
              ),
            ])
          )
        );
      }),

      b.exportNamedDeclaration(
        b.tsInterfaceDeclaration(
          b.identifier("Builders"),
          b.tsInterfaceBody([
            ...builderTypeNames.map(typeName =>
              b.tsPropertySignature(
                b.identifier(getBuilderName(typeName)),
                b.tsTypeAnnotation(b.tsTypeReference(b.identifier(`${typeName}Builder`)))
              )
            ),
            b.tsIndexSignature(
              [
                b.identifier.from({
                  name: "builderName",
                  typeAnnotation: b.tsTypeAnnotation(b.tsStringKeyword()),
                }),
              ],
              b.tsTypeAnnotation(b.tsAnyKeyword())
            ),
          ])
        )
      ),
    ]),
  },
  {
    file: "visitor.ts",
    ast: moduleWithBody([
      b.importDeclaration(
        [b.importSpecifier(b.identifier("NodePath"))],
        b.stringLiteral("../lib/node-path")
      ),
      b.importDeclaration(
        [b.importSpecifier(b.identifier("Context"))],
        b.stringLiteral("../lib/path-visitor")
      ),
      NODES_IMPORT,
      b.exportNamedDeclaration(
        b.tsInterfaceDeclaration.from({
          id: b.identifier("Visitor"),
          typeParameters: b.tsTypeParameterDeclaration([
            b.tsTypeParameter("M", undefined, b.tsTypeLiteral([])),
          ]),
          body: b.tsInterfaceBody([
            ...Object.keys(astTypes.namedTypes).map(typeName => {
              return b.tsMethodSignature.from({
                key: b.identifier(`visit${typeName}`),
                parameters: [
                  b.identifier.from({
                    name: "this",
                    typeAnnotation: b.tsTypeAnnotation(
                      b.tsIntersectionType([
                        b.tsTypeReference(b.identifier("Context")),
                        b.tsTypeReference(b.identifier("M")),
                      ])
                    ),
                  }),
                  b.identifier.from({
                    name: "path",
                    typeAnnotation: b.tsTypeAnnotation(
                      b.tsTypeReference(
                        b.identifier("NodePath"),
                        b.tsTypeParameterInstantiation([
                          b.tsTypeReference(b.tsQualifiedName(NODES_ID, b.identifier(typeName))),
                        ])
                      )
                    ),
                  }),
                ],
                optional: true,
                typeAnnotation: b.tsTypeAnnotation(b.tsAnyKeyword()),
              });
            }),
          ]),
        })
      ),
    ]),
  },
];

out.forEach(({ file, ast }) => {
  fs.writeFileSync(
    path.resolve(__dirname, `../gen/${file}`),
    prettyPrint(ast, { tabWidth: 2, includeComments: true }).code
  );
});

function moduleWithBody(body: any[]) {
  return b.file.from({
    comments: [b.commentBlock(" !!! THIS FILE WAS AUTO-GENERATED BY `npm run gen` !!! ")],
    program: b.program(body),
  });
}

function getSupertypeToSubtypes() {
  const supertypeToSubtypes: { [supertypeName: string]: string[] } = {};
  Object.keys(astTypes.namedTypes).map(typeName => {
    astTypes.Type.def(typeName).supertypeList.forEach(supertypeName => {
      supertypeToSubtypes[supertypeName] = supertypeToSubtypes[supertypeName] || [];
      supertypeToSubtypes[supertypeName].push(typeName);
    });
  });

  return supertypeToSubtypes;
}

function getBuilderTypeNames() {
  return Object.keys(astTypes.namedTypes).filter(typeName => {
    const typeDef = astTypes.Type.def(typeName);
    const builderName = getBuilderName(typeName);

    return !!typeDef.buildParams && !!(astTypes.builders as any)[builderName];
  });
}

function getTSTypeAnnotation(type: Type<any>): any {
  switch (type.kind) {
    case "ArrayType": {
      const elemTypeAnnotation = getTSTypeAnnotation(type.elemType);
      // TODO Improve this test.
      return n.TSUnionType.check(elemTypeAnnotation)
        ? b.tsArrayType(b.tsParenthesizedType(elemTypeAnnotation))
        : b.tsArrayType(elemTypeAnnotation);
    }

    case "IdentityType": {
      if (type.value === null) {
        return b.tsNullKeyword();
      }
      switch (typeof type.value) {
        case "undefined":
          return b.tsUndefinedKeyword();
        case "string":
          return b.tsLiteralType(b.stringLiteral(type.value));
        case "boolean":
          return b.tsLiteralType(b.booleanLiteral(type.value));
        case "number":
          return b.tsNumberKeyword();
        case "object":
          return b.tsObjectKeyword();
        case "function":
          return b.tsFunctionType([]);
        case "symbol":
          return b.tsSymbolKeyword();
        default:
          return b.tsAnyKeyword();
      }
    }

    case "ObjectType": {
      return b.tsTypeLiteral(
        type.fields.map(field =>
          b.tsPropertySignature(
            b.identifier(field.name),
            b.tsTypeAnnotation(getTSTypeAnnotation(field.type))
          )
        )
      );
    }

    case "OrType": {
      return b.tsUnionType(type.types.map(type => getTSTypeAnnotation(type)));
    }

    case "PredicateType": {
      if (typeof type.name !== "string") {
        return b.tsAnyKeyword();
      }

      if (hasOwn.call(n, type.name)) {
        return b.tsTypeReference(b.tsQualifiedName(KINDS_ID, b.identifier(`${type.name}Kind`)));
      }

      if (/^[$A-Z_][a-z0-9_$]*$/i.test(type.name)) {
        return b.tsTypeReference(b.identifier(type.name));
      }

      if (/^number [<>=]+ \d+$/.test(type.name)) {
        return b.tsNumberKeyword();
      }

      // Not much else to do...
      return b.tsAnyKeyword();
    }

    default:
      return assertNever(type);
  }
}

function assertNever(x: never): never {
  throw new Error("Unexpected: " + x);
}
