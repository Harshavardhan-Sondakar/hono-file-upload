import { describe, expect, it } from 'vitest'
import { parseDisposition } from '../src/content-disposition'

describe('parseDisposition', () => {
  it.each([
    ['form-data; name="title"', { name: 'title', filename: undefined }],
    ['form-data; name="a"; filename="b.txt"', { name: 'a', filename: 'b.txt' }],
    ['form-data; name=plain; filename=x.txt', { name: 'plain', filename: 'x.txt' }],
    ['form-data;name="a";filename="b"', { name: 'a', filename: 'b' }],
    ['FORM-DATA; NAME="a"; FILENAME="b"', { name: 'a', filename: 'b' }],
    ['form-data; name="a"; filename=""', { name: 'a', filename: '' }],
    ['form-data; name="a"; filename="x\\"y\\\\z"', { name: 'a', filename: 'x"y\\z' }],
    ['form-data; name="a"; filename="semi;colon.txt"', { name: 'a', filename: 'semi;colon.txt' }],
    [`form-data; name="a"; filename="f"; filename*=UTF-8''%E2%82%AC.txt`, { name: 'a', filename: '€.txt' }],
    [`form-data; name="a"; filename*=utf-8'en'caf%C3%A9`, { name: 'a', filename: 'café' }],
    // bad encodings fall back to the plain filename
    [`form-data; name="a"; filename="f"; filename*=UTF-8''%E2%82`, { name: 'a', filename: 'f' }],
    [`form-data; name="a"; filename="f"; filename*=ISO-8859-1''x`, { name: 'a', filename: 'f' }],
    // the first value wins if a parameter repeats
    ['form-data; name="a"; name="b"', { name: 'a', filename: undefined }],
    ['form-data', { name: undefined, filename: undefined }],
  ])('%s', (header, expected) => {
    expect(parseDisposition(header)).toEqual(expected)
  })

  it('handles a missing header', () => {
    expect(parseDisposition(undefined)).toEqual({})
  })

  it('does not hang on an unterminated quote', () => {
    expect(parseDisposition('form-data; name="a; filename="b')).toEqual({ name: 'a; filename=', filename: undefined })
  })
})
