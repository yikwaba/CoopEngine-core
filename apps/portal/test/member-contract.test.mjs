import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import ts from 'typescript';

function contract(source, filename) {
  const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declaration = ast.statements.find(node => ts.isInterfaceDeclaration(node) && node.name.text === 'Member360');
  assert.ok(declaration, `${filename} declares Member360`);
  function fields(members) {
    return Object.fromEntries(members.map(member => {
      const type = member.type;
      const nested = ts.isArrayTypeNode(type) ? type.elementType : type;
      return [member.name.getText(ast), ts.isTypeLiteralNode(nested) ? fields(nested.members) : type.getText(ast)];
    }));
  }
  return { ast, fields: fields(declaration.members) };
}

test('member page fields match the actual member report API contract', async () => {
  const backend = contract(await readFile(new URL('../../api/src/reports/reports.service.ts', import.meta.url), 'utf8'), 'reports.service.ts');
  const frontend = contract(await readFile(new URL('../src/app/members/[id]/page.tsx', import.meta.url), 'utf8'), 'page.tsx');
  function compare(actual, expected, prefix = '') {
    for (const [name, value] of Object.entries(actual)) {
      assert.ok(Object.hasOwn(expected, name), `${prefix}${name} is returned by the API`);
      if (typeof value === 'object') compare(value, expected[name], `${prefix}${name}.`);
      else assert.equal(value, expected[name], `${prefix}${name} has the API type`);
    }
  }
  compare(frontend.fields, backend.fields);

  // Check the actual JSX/action expressions too, so changing only the local
  // interface cannot conceal a stale render field or savings account ID.
  const shapes = { data: backend.fields, a: backend.fields.savings, l: backend.fields.loans };
  function visit(node) {
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
      const shape = shapes[node.expression.text];
      if (shape) assert.ok(Object.hasOwn(shape, node.name.text), `${node.getText(frontend.ast)} uses a returned field`);
    }
    ts.forEachChild(node, visit);
  }
  const component = frontend.ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'MemberDetailPage');
  assert.ok(component, 'member record component exists');
  visit(component);
});
